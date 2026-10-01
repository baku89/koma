/**
 * Parsing of Grbl / FluidNC real-time status reports (`<Idle|MPos:...|...>`)
 * and the push messages that surround them (`ok`, `error:N`, `ALARM:N`,
 * `[MSG:...]`, the `Grbl x.y [...]` banner).
 *
 * Pure functions, no DOM — unit-tested in status.test.ts.
 */

export type Axis = 'x' | 'y' | 'z' | 'a' | 'b' | 'c'

export const AXES: readonly Axis[] = ['x', 'y', 'z', 'a', 'b', 'c']

export type AxesPosition = Partial<Record<Axis, number>>

/** Machine state as reported in the first field of a status report. */
export type MachineState =
	| 'Idle'
	| 'Run'
	| 'Hold'
	| 'Jog'
	| 'Alarm'
	| 'Door'
	| 'Check'
	| 'Home'
	| 'Sleep'
	| (string & {})

export interface MachineStatus {
	state: MachineState
	/** Sub-state, e.g. `Hold:0` (complete) / `Hold:1` (in progress). */
	subState?: number
	/** Machine position (MPos). Present when the report carried it. */
	mpos?: AxesPosition
	/** Work position (WPos). Present when the report carried it. */
	wpos?: AxesPosition
	/** Work coordinate offset (WCO). Reported only every N reports. */
	wco?: AxesPosition
	feedRate?: number
	spindleSpeed?: number
	buffer?: {planner: number; rx: number}
	lineNumber?: number
	override?: {feed: number; rapid: number; spindle: number}
	/** Raw pin letters from `Pn:` (e.g. "XYZPDHRS"). */
	pins?: string
	/** Accessory letters from `A:` (S/C/F/M). */
	accessories?: string
	/** FluidNC: `SD:percent,filename` while running a file from SD. */
	sd?: {progress: number; filename: string}
	/** Any unrecognised fields, kept verbatim for debugging. */
	extra?: Record<string, string>
}

export function isStatusReport(line: string): boolean {
	return line.startsWith('<') && line.endsWith('>')
}

function parseAxes(csv: string): AxesPosition {
	const out: AxesPosition = {}
	csv.split(',').forEach((v, i) => {
		const axis = AXES[i]
		if (!axis) return
		const n = Number(v)
		if (Number.isFinite(n)) out[axis] = n
	})
	return out
}

/**
 * Parse a `<...>` status report. Throws on a line that isn't one.
 */
export function parseStatusReport(line: string): MachineStatus {
	const m = line.trim().match(/^<(.*)>$/)
	if (!m) throw new Error(`Not a status report: ${line}`)

	const [stateField, ...fields] = m[1].split('|')
	const [state, sub] = stateField.split(':')

	const status: MachineStatus = {state}
	if (sub !== undefined && sub !== '') status.subState = Number(sub)

	for (const field of fields) {
		const idx = field.indexOf(':')
		const key = idx === -1 ? field : field.slice(0, idx)
		const value = idx === -1 ? '' : field.slice(idx + 1)

		switch (key) {
			case 'MPos':
				status.mpos = parseAxes(value)
				break
			case 'WPos':
				status.wpos = parseAxes(value)
				break
			case 'WCO':
				status.wco = parseAxes(value)
				break
			case 'FS': {
				const [f, s] = value.split(',').map(Number)
				status.feedRate = f
				status.spindleSpeed = s
				break
			}
			case 'F':
				status.feedRate = Number(value)
				break
			case 'Bf': {
				const [planner, rx] = value.split(',').map(Number)
				status.buffer = {planner, rx}
				break
			}
			case 'Ln':
				status.lineNumber = Number(value)
				break
			case 'Ov': {
				const [feed, rapid, spindle] = value.split(',').map(Number)
				status.override = {feed, rapid, spindle}
				break
			}
			case 'Pn':
				status.pins = value
				break
			case 'A':
				status.accessories = value
				break
			case 'SD': {
				const comma = value.indexOf(',')
				status.sd = {
					progress: Number(comma === -1 ? value : value.slice(0, comma)),
					filename: comma === -1 ? '' : value.slice(comma + 1),
				}
				break
			}
			default:
				;(status.extra ??= {})[key] = value
		}
	}

	return status
}

//------------------------------------------------------------------------------
// Input pins (`Pn:`)

export interface PinStates {
	/** Axes whose limit switch reads active. */
	limits: Axis[]
	probe: boolean
	/**
	 * Every other active input, as its report letter: control pins (D door,
	 * H feed hold, R reset, S cycle start, E e-stop, F fault, 0-3 macros) and
	 * T (toolsetter).
	 */
	others: string[]
}

/** Names for the non-limit `Pn:` letters (Grbl 1.1 + FluidNC). */
export const PIN_LABELS: Record<string, string> = {
	P: 'Probe',
	T: 'Toolsetter',
	D: 'Door',
	H: 'Feed hold',
	R: 'Reset',
	S: 'Cycle start',
	E: 'E-stop',
	F: 'Fault',
}

/**
 * Split the `Pn:` letters into limit switches and the rest. A report without
 * `Pn:` means no input is active, so `undefined` parses as "all clear".
 *
 * A dual-motor axis reports one letter for both of its switches, and a
 * floating (unwired) input can read active.
 */
export function parsePins(pins: string | undefined): PinStates {
	const out: PinStates = {limits: [], probe: false, others: []}
	for (const letter of pins ?? '') {
		const axis = letter.toLowerCase() as Axis
		if (letter === 'P') out.probe = true
		else if (AXES.includes(axis) && letter !== axis) out.limits.push(axis)
		else out.others.push(letter)
	}
	return out
}

/** Subtract a work coordinate offset from a machine position. */
export function mposToWpos(mpos: AxesPosition, wco: AxesPosition): AxesPosition {
	const out: AxesPosition = {}
	for (const axis of AXES) {
		const m = mpos[axis]
		if (m === undefined) continue
		out[axis] = m - (wco[axis] ?? 0)
	}
	return out
}

//------------------------------------------------------------------------------
// Push messages

export type PushMessage =
	| {type: 'ok'}
	| {type: 'error'; code: number}
	| {type: 'alarm'; code: number}
	| {type: 'status'; status: MachineStatus}
	| {type: 'message'; text: string}
	| {type: 'banner'; version: string}
	/** `[VER:...]`, `[OPT:...]`, `[GC:...]`, `[G54:...]` etc. */
	| {type: 'bracket'; key: string; value: string}
	| {type: 'other'; text: string}

export function classifyLine(raw: string): PushMessage {
	const line = raw.trim()

	if (line === 'ok') return {type: 'ok'}
	if (line.startsWith('error:')) {
		return {type: 'error', code: Number(line.slice(6))}
	}
	if (line.startsWith('ALARM:')) {
		return {type: 'alarm', code: Number(line.slice(6))}
	}
	if (isStatusReport(line)) {
		return {type: 'status', status: parseStatusReport(line)}
	}
	if (line.startsWith('[MSG:')) {
		return {type: 'message', text: line.slice(5, -1).trim()}
	}
	if (/^Grbl \d/.test(line)) {
		return {type: 'banner', version: line}
	}
	const bracket = line.match(/^\[([A-Za-z0-9]+):(.*)\]$/)
	if (bracket) {
		return {type: 'bracket', key: bracket[1], value: bracket[2]}
	}
	return {type: 'other', text: line}
}

//------------------------------------------------------------------------------
// $I build info

export interface BuildInfo {
	/** `[VER:3.9 FluidNC v3.9.9:]` → "3.9 FluidNC v3.9.9" */
	version?: string
	options?: string
	/** FluidNC `name:` from config.yaml, reported as `[MSG: Machine: <name>]`. */
	machineName?: string
	/** Every raw line, for the log. */
	lines: string[]
}

export function parseBuildInfo(lines: string[]): BuildInfo {
	const info: BuildInfo = {lines}
	for (const raw of lines) {
		const line = raw.trim()
		const ver = line.match(/^\[VER:(.*?):?\]$/)
		if (ver) info.version = ver[1].trim()
		const opt = line.match(/^\[OPT:(.*)\]$/)
		if (opt) info.options = opt[1]
		const machine = line.match(/^\[MSG:\s*Machine:\s*(.*?)\s*\]$/)
		if (machine) info.machineName = machine[1]
	}
	return info
}

//------------------------------------------------------------------------------
// Error / alarm tables (Grbl 1.1 + FluidNC)

export const ALARM_MESSAGES: Record<number, string> = {
	1: 'Hard limit triggered',
	2: 'Soft limit: target exceeds machine travel',
	3: 'Reset while in motion',
	4: 'Probe fail: not in expected initial state',
	5: 'Probe fail: did not contact within travel',
	6: 'Homing fail: reset during active homing cycle',
	7: 'Homing fail: safety door opened during homing',
	8: 'Homing fail: pull-off did not clear the limit switch',
	9: 'Homing fail: could not find limit switch within search distance',
	10: 'Spindle control error',
	11: 'Control pin initially in an active state',
	12: 'Ambiguous limit switch touching',
	13: 'Hard stop',
	14: 'Unhomed axes',
}

export const ERROR_MESSAGES: Record<number, string> = {
	1: 'Expected command letter',
	2: 'Bad number format',
	3: 'Invalid $ statement',
	4: 'Negative value',
	5: 'Setting disabled',
	6: 'Step pulse too short',
	7: 'Failed to read settings',
	8: 'Command requires idle state',
	9: 'G-code cannot be executed in lock or alarm state',
	10: 'Soft limit error',
	11: 'Line too long',
	12: 'Max step rate exceeded',
	13: 'Check door',
	14: 'Startup line too long',
	15: 'Max travel exceeded during jog',
	16: 'Invalid jog command',
	17: 'Laser mode requires PWM output',
	20: 'Unsupported command',
	21: 'Modal group violation',
	22: 'Undefined feed rate',
	23: 'Invalid G-code command value',
	24: 'Multiple axis commands in the same block',
	25: 'Word repeated',
	26: 'No axis words',
	27: 'Invalid line number',
	28: 'Missing required value',
	29: 'G59.x not supported',
	30: 'G53 requires G0 or G1',
	31: 'Axis words not allowed',
	32: 'G2/G3 missing axis words',
	33: 'Invalid target',
	34: 'Arc radius error',
	35: 'G2/G3 missing offset word',
	36: 'Unused value words',
	37: 'G43.1 offset not assigned',
	38: 'Invalid tool number',
	60: 'SD card failed to mount',
	61: 'SD card failed to open file',
	62: 'SD card failed to open directory',
	63: 'SD card directory not found',
	64: 'SD card file empty',
	70: 'Bluetooth failed to start',
	71: 'WiFi failed to start',
	80: 'Number out of range',
	81: 'Invalid value',
	82: 'Failed to create file',
	83: 'Failed to format file',
	84: 'Failed to open file',
	85: 'Failed to parse file',
	90: 'Cannot parse config',
	100: 'Another interface is busy',
	120: 'Jog cancelled',
	150: 'Bad pin specification',
	152: 'Configuration is invalid',
	160: 'File not found',
	161: 'File not found (retry)',
	162: 'Idle timeout',
}
