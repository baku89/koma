/**
 * Pinia store factory for one FluidNC-controlled machine (a mill, a motion
 * control rig, …) connected over Web Serial.
 *
 * Several machines can share one USB serial chip model, so a saved
 * `SerialPortInfo` (vendor/product id) cannot tell them apart. Instead every
 * paired port is opened once, asked `$I`, and handed to the machine whose
 * `fluidncName` matches the controller's `name:` (from its config.yaml). This
 * runs at startup and whenever a port is (re)plugged, so a reload or a PC
 * sleep recovers without a picker (`navigator.serial.getPorts()` needs no
 * user gesture; `requestPort()` does). Port ownership across device families
 * (e.g. an LED driver on the same chip) is arbitrated by utils/serialDiscovery.
 */

import {defineStore} from 'pinia'
import {useTweeq} from 'tweeq'
import {computed, readonly, ref, shallowRef, watch} from 'vue'

import {
	type AxesPosition,
	axesWords,
	type Axis,
	type BuildInfo,
	classifyLine,
	coolantAfterLine,
	type CoolantState,
	type FeedOverrideStep,
	FluidNCClient,
	FluidNCError,
	jogLine,
	type JogOptions,
	machineMoveLine,
	type MachineStatus,
	parseCoolant,
	parsePins,
	type RapidOverride,
	type SendOptions,
	spindleAfterLine,
	type StreamOptions,
	type WaitOptions,
} from '@/utils/fluidnc'
import {
	identifyController,
	inAlarm,
	isSuspended,
	likelyOwner,
	serialPortId,
} from '@/utils/fluidnc/identify'
import {
	claimSerialPort,
	describeSerialPort,
	discoverSerialPorts,
	registerSerialFamily,
	releaseSerialPort,
	requestSerialPort,
	resetRejections,
	type SerialFamily,
	serialPortLabel,
	type SerialProbeResult,
	serialRequestError,
} from '@/utils/serialDiscovery'

export interface AxisInfo {
	unit: 'mm' | 'deg'
	label?: string
}

export interface MachineDefinition {
	/** Short stable id, used for config keys and the store id. */
	id: string
	label: string
	/** Iconify name shown wherever this machine appears (title bar, tab, panel). */
	icon: string
	/**
	 * FluidNC `name:` to match when identifying a port. Undefined = accept any
	 * controller (only sensible with a single machine).
	 */
	fluidncName?: string
	/**
	 * Take any Grbl / FluidNC controller whose name matches no machine (an
	 * unnamed board, plain Grbl, a stale config.yaml). One machine at most
	 * should be the fallback; a named match always wins over it.
	 */
	fluidncFallback?: boolean
	axes: readonly Axis[]
	axisInfo?: Partial<Record<Axis, AxisInfo>>
	/** Default jog feed (mm/min or deg/min). */
	jogFeed?: number
	baudRate?: number
	statusInterval?: number
	/** How MachinePanel lays this machine out. */
	panel?: MachinePanelOptions
}

/**
 * A homing cycle: steps run one after another, each an axis or several axes
 * homed together — e.g. `['y', ['x', 'z']]` = Y, then X and Z at once.
 */
export type HomingSteps = readonly (Axis | readonly Axis[])[]

export interface MachinePanelOptions {
	/** Axis cells per row (default 3: X Y Z / A B C). */
	gridColumns?: number
	/**
	 * "Home" buttons next to "All", each with its own cycle. Default: the
	 * linear and the rotary axes as a group each, one axis at a time (only
	 * when the machine has both).
	 */
	homeGroups?: readonly {label: string; steps: HomingSteps}[]
	/** Hide the jog feed input (the stored default is still used). */
	showFeed?: boolean
	/**
	 * Coolant outputs to offer as on/off buttons, labelled by what is wired
	 * to them (e.g. `{flood: 'Dust collector'}` for M8/M9). None = no row.
	 */
	outputs?: {flood?: string; mist?: string}
	/**
	 * Offer a switch to run the spindle by hand (M3 / M5), at `defaultSpeed` at
	 * first. `maxSpeed` is the S at 100% in the controller's `speed_map`.
	 */
	spindle?: {defaultSpeed: number; maxSpeed: number}
}

/**
 * A coordinate frame the machine's panel can show and move in, besides the
 * controller's own Machine (MPos) and Work (MPos − WCO): e.g. a frame with a
 * measured distortion taken out. Both conversions take the axes given and
 * answer for those; a frame whose correction couples the axes fills the
 * missing ones in from where the machine is.
 */
export interface MachineFrame {
	id: string
	label: string
	/** Shown with the position field. */
	hint?: string
	/** Machine → this frame. */
	fromMachine: (machine: AxesPosition) => AxesPosition
	/** This frame → machine, for a move. */
	toMachine: (axes: AxesPosition) => AxesPosition
}

/**
 * The lines of a homing cycle: `$HX` for an axis alone, `$H=XZ` for axes
 * homed together (FluidNC has no `$HXZ`).
 */
export function homingLines(steps: HomingSteps): string[] {
	return steps.map(step => {
		const axes = (typeof step === 'string' ? [step] : step).map(a => a.toUpperCase())
		return axes.length === 1 ? `$H${axes[0]}` : `$H=${axes.join('')}`
	})
}

const LOG_LIMIT = 500

/** Wait this long after a hold is released before asking `$I` (ms). */
const RELEASE_SETTLE = 300

//------------------------------------------------------------------------------
// Port discovery: all FluidNC machines form one "family" (utils/serialDiscovery)
// so a port is identified with $I once and handed to whichever machine claims
// that name — never re-opened per machine (opening a port can reset the board).

interface Registration {
	def: MachineDefinition
	/** The current user-editable name (config override). */
	name: () => string | undefined
	/**
	 * `info` null: a held controller that could not be asked `$I` yet — taken
	 * on trust until it is released (see `isSuspended`).
	 */
	adopt: (client: FluidNCClient, info: BuildInfo | null, fallback: boolean) => void
	hasClient: () => boolean
	/** The port this machine is connected on, if any. */
	port: () => SerialPort | undefined
	/** Show `message` on this machine's panel. */
	notify: (message: string) => void
	/** Take back what `notify` showed, if it is still showing. */
	clearNotice: () => void
	/** The USB chip it was last identified on (`serialPortId`), '' if never. */
	lastPortId: () => string
}

const registrations = new Map<string, Registration>()

/**
 * `holding`: the machine that already has this very controller open (a held
 * one, identified late) — it counts as free to take it.
 */
function findOwner(
	info: BuildInfo,
	preferred?: string,
	holding?: string
): {owner: Registration; fallback: boolean} | null {
	const name = info.machineName
	const regs = [...registrations.values()]
	const pick = (list: Registration[]) =>
		list.find(r => r.def.id === preferred) ?? list[0] ?? null
	const free = (r: Registration) => !r.hasClient() || r.def.id === holding
	// Exact name match first (the preferred machine wins a tie). A match that
	// is already connected still wins — the port is then refused rather than
	// handed to the fallback machine.
	const byName = regs.filter(r => name !== undefined && r.name() === name)
	if (byName.length) return {owner: pick(byName)!, fallback: false}
	// Otherwise an unconstrained machine (no name required) may take it, then
	// the fallback one ("looks like Grbl → it's the mill").
	const open = regs.filter(r => r.name() === undefined && free(r))
	const unconstrained = pick(open)
	if (unconstrained) return {owner: unconstrained, fallback: false}
	const fallback = pick(regs.filter(r => r.def.fluidncFallback && free(r)))
	return fallback ? {owner: fallback, fallback: true} : null
}

const FAMILY_ID = 'fluidnc'

/**
 * Probe a port as FluidNC and hand it to the matching machine. `preferred`
 * breaks ties when the user picked the port from that machine's panel.
 *
 * A suspended controller can't say which machine it is. Picked from a
 * machine's panel, it is connected there unidentified, so that it can be
 * resumed or reset — the machine asks `$I` once it is released. Otherwise
 * (background discovery, a pick from elsewhere) it is left alone and the
 * machines still looking for a controller say so.
 */
async function probe(
	port: SerialPort,
	preferred?: string
): Promise<SerialProbeResult> {
	const wanting = [...registrations.values()].filter(r => !r.hasClient())
	if (wanting.length === 0) return false
	const first = wanting.find(r => r.def.id === preferred) ?? wanting[0]
	let client: FluidNCClient
	let info: BuildInfo | null
	try {
		;({client, info} = await identifyController(port, {
			baudRate: first.def.baudRate,
			statusInterval: first.def.statusInterval,
		}))
	} catch {
		return false
	}
	if (!info) {
		const picked =
			wanting.find(r => r.def.id === preferred) ?? likelyOwner(wanting, serialPortId(port))
		if (picked) {
			for (const r of registrations.values()) r.clearNotice()
			picked.adopt(client, null, false)
			lastProbe = {name: undefined, ownerId: picked.def.id}
			return true
		}
		const state = client.status?.state ?? 'Hold'
		await client.close()
		const where = describeSerialPort(port)
		const how = state === 'Alarm' ? 'reset it (Ctrl-X)' : 'resume or reset it'
		for (const r of wanting) {
			r.notify(
				`A controller in ${state} is waiting on a port (${where}) and can't say which machine it is. If it is the ${r.def.label}, press Connect… and pick it, then ${how}`
			)
		}
		return {
			undecided: `The controller on that port is in ${state}, so it can't say which machine it is — press Connect… on that machine's panel and pick it, then ${how}`,
		}
	}
	const found = findOwner(info, preferred)
	if (found && !found.owner.hasClient()) {
		for (const r of registrations.values()) r.clearNotice()
		found.owner.adopt(client, info, found.fallback)
		lastProbe = {name: info.machineName, ownerId: found.owner.def.id}
		return true
	}
	lastProbe = {name: info.machineName, ownerId: null}
	await client.close()
	return false
}

/** What the most recent probe found — for the panel's error message. */
let lastProbe: {name: string | undefined; ownerId: string | null} | null = null

export const FLUIDNC_FAMILY_ID = 'fluidnc'

// Read through a function so TS doesn't narrow the module-level `let` to null
// across the awaits in connect().
function getLastProbe() {
	return lastProbe
}

const family: SerialFamily = {
	id: FAMILY_ID,
	label: 'FluidNC',
	wants: () => [...registrations.values()].some(r => !r.hasClient()),
	probe: port => probe(port),
	holder: port =>
		[...registrations.values()].find(r => r.port() === port)?.def.label ?? null,
}

registerSerialFamily(family)

//------------------------------------------------------------------------------

export function defineMachineStore(def: MachineDefinition) {
	return defineStore(`machine:${def.id}`, () => {
		const Tq = useTweeq()
		const config = Tq.config.group(`machine.${def.id}`)

		/** Editable override of the FluidNC name to match (persisted). */
		const fluidncName = config.ref<string>('fluidncName', def.fluidncName ?? '')
		const jogFeed = config.ref('jogFeed', def.jogFeed ?? 1000)
		const jogStep = config.ref('jogStep', 1)
		/** The USB chip of the last controller identified as this machine. */
		const lastPortId = config.ref<string>('lastPortId', '')

		const client = shallowRef<FluidNCClient | null>(null)
		const connecting = ref(false)
		const status = ref<MachineStatus | null>(null)
		const buildInfo = ref<BuildInfo | null>(null)
		const alarm = ref<{code: number; message: string} | null>(null)
		const lastError = ref<string | null>(null)
		const log = ref<{dir: 'rx' | 'tx' | 'sys'; text: string; t: number}[]>([])
		const busy = ref(false)
		const streamProgress = ref<{index: number; total: number} | null>(null)
		/**
		 * Feed / rapid / spindle override in % (Grbl `Ov:`). Reports carry it
		 * only when it changed or every N reports, so the last seen value is
		 * kept here; null until the controller has said.
		 */
		const override = ref<{feed: number; rapid: number; spindle: number} | null>(null)
		/**
		 * Coolant outputs (M7 / M8 / M9) as koma believes them to be: tracked
		 * from every line it sends (the switch, typed lines, streamed G-code),
		 * off after a reset. The `A:` letters of status reports only ever
		 * confirm an output is on — they come only with `Ov:`, and FluidNC
		 * reads them back from the pin, which was seen not to reflect the
		 * commanded state — so their absence never switches anything off here.
		 */
		const coolant = ref<CoolantState>({flood: false, mist: false})
		/**
		 * Spindle on, as koma believes: tracked from every line it sends like
		 * `coolant`, off after a reset or an alarm (both stop it).
		 */
		const spindleOn = ref(false)
		/** The S the spindle switch runs at. */
		const spindleTestSpeed = config.ref('spindleTestSpeed', def.panel?.spindle?.defaultSpeed ?? 0)
		/**
		 * Connected to a controller that was suspended (Hold / Door) when its
		 * port was picked, so it has not said which machine it is. Only the
		 * real-time commands (resume, reset, …) go through until it is released
		 * and `$I` confirms it is this machine.
		 */
		const unidentified = ref(false)

		const connected = computed(() => client.value !== null)
		const state = computed(() => status.value?.state ?? null)
		const mpos = computed<AxesPosition>(() => status.value?.mpos ?? {})
		/**
		 * Work position: the controller's own WPos, or MPos − WCO (the client
		 * remembers the last WCO, which only comes every few reports). Empty
		 * until a WCO has arrived — never machine coordinates in disguise.
		 */
		const wpos = computed<AxesPosition>(() => status.value?.wpos ?? {})
		/**
		 * Work coordinate offset (machine position of the work origin), null
		 * until the controller has reported it.
		 */
		const wco = computed<AxesPosition | null>(() => status.value?.wco ?? null)
		const isIdle = computed(() => state.value === 'Idle')
		/**
		 * Inputs reading active in the last report (`Pn:`): limit switches by
		 * axis, probe, control pins. As fresh as the status poll.
		 */
		const pins = computed(() => parsePins(status.value?.pins))

		function pushLog(dir: 'rx' | 'tx' | 'sys', text: string) {
			log.value.push({dir, text, t: Date.now()})
			if (log.value.length > LOG_LIMIT) log.value.splice(0, log.value.length - LOG_LIMIT)
		}

		function logIdentity(info: BuildInfo, fallback: boolean) {
			pushLog(
				'sys',
				`Connected: ${info.machineName ?? '(unnamed)'} ${info.version ?? ''}${info.board ? ` (${info.board})` : ''}`
			)
			if (fallback) {
				pushLog(
					'sys',
					`Taken as ${def.label} because "${info.machineName ?? '(unnamed)'}" matches no machine name`
				)
			}
		}

		/**
		 * The unidentified controller is in a critical alarm: `$I` went
		 * unanswered and will until it is reset. Don't ask again before the
		 * banner (the 'reset' event) — or the state leaving Alarm.
		 */
		let identityWaitsForReset = false

		function adopt(c: FluidNCClient, info: BuildInfo | null, fallback: boolean) {
			claimSerialPort(c.port, FAMILY_ID)
			client.value = c
			buildInfo.value = info
			unidentified.value = info === null
			identityWaitsForReset = info === null && inAlarm(c.status)
			status.value = c.status
			alarm.value = null
			lastError.value = null
			if (info) {
				logIdentity(info, fallback)
				lastPortId.value = serialPortId(c.port)
			} else if (identityWaitsForReset) {
				pushLog(
					'sys',
					'Connected to a controller in Alarm that answers nothing but a reset (a hard / soft limit alarm): reset it (Ctrl-X) and it will say which machine it is'
				)
			} else {
				pushLog(
					'sys',
					`Connected to a controller in ${c.status?.state ?? 'Hold'}: it can't say which machine it is until it is resumed (~) or reset (Ctrl-X)`
				)
			}

			c.on('status', s => {
				status.value = s
				if (s.override) {
					override.value = s.override
					const seen = parseCoolant(s.accessories)
					if ((seen.flood && !coolant.value.flood) || (seen.mist && !coolant.value.mist)) {
						coolant.value = {
							flood: coolant.value.flood || seen.flood,
							mist: coolant.value.mist || seen.mist,
						}
					}
				}
				if (s.state !== 'Alarm') alarm.value = null
				if (unidentified.value && !isSuspended(s) && !(identityWaitsForReset && inAlarm(s))) {
					void confirmIdentity(c)
				}
			})
			// Status reports (`<Idle|MPos:…>`, the answer to koma's `?` poll every
			// 200 ms) would drown everything else; they are shown as the axis
			// readouts instead.
			c.on('line', l => {
				if (classifyLine(l).type !== 'status') pushLog('rx', l)
			})
			c.on('sent', l => {
				pushLog('tx', l)
				const next = coolantAfterLine(l, coolant.value)
				if (next !== coolant.value) coolant.value = next
				spindleOn.value = spindleAfterLine(l, spindleOn.value)
			})
			c.on('alarm', a => {
				alarm.value = a
				spindleOn.value = false
			})
			c.on('readError', () => {
				pushLog('sys', 'Serial read error (noise on the line) — still connected')
			})
			c.on('reset', () => {
				override.value = null
				coolant.value = {flood: false, mist: false}
				spindleOn.value = false
				// Out of a critical alarm now (the state may still read Alarm,
				// but line commands run again): ask who it is on the next report.
				identityWaitsForReset = false
				pushLog('sys', 'Controller reset')
			})
			c.on('disconnect', () => {
				if (client.value !== c) return
				releaseSerialPort(c.port)
				client.value = null
				status.value = null
				override.value = null
				coolant.value = {flood: false, mist: false}
				spindleOn.value = false
				unidentified.value = false
				busy.value = false
				streamProgress.value = null
				pushLog('sys', 'Disconnected')
			})
		}

		let confirming = false
		/** What `notify` last put in `lastError`. */
		let notice: string | null = null

		/**
		 * The controller taken on while suspended has been released: ask `$I`
		 * at last. If it turns out to be another machine, let go of the port
		 * and have discovery hand it over.
		 */
		async function confirmIdentity(c: FluidNCClient) {
			if (confirming) return
			confirming = true
			try {
				// Lines that were waiting in the controller run first now; let
				// their output (and `ok`) pass so it isn't taken for the answer.
				await new Promise(resolve => setTimeout(resolve, RELEASE_SETTLE))
				let info: BuildInfo | null = null
				for (let attempt = 0; attempt < 3 && !info; attempt++) {
					if (client.value !== c) return
					// Held again meanwhile: the next release comes back here.
					if (isSuspended(c.status)) return
					try {
						const answer = await c.getBuildInfo()
						// An `ok` left over from before the hold answers with nothing.
						if (answer.version !== undefined || answer.machineName !== undefined) {
							info = answer
						}
					} catch {
						// Ask again.
					}
				}
				if (client.value !== c) return
				if (!info) {
					if (isSuspended(c.status)) return
					if (inAlarm(c.status)) {
						// A critical alarm: nothing but a reset gets through. Keep
						// the connection (that is what the Reset button needs).
						identityWaitsForReset = true
						lastError.value =
							'The controller is in an alarm that answers nothing but a reset — press Reset (Ctrl-X), then it can say which machine it is'
						pushLog('sys', lastError.value)
						return
					}
					await c.close()
					lastError.value =
						'The controller did not answer $I after it was released — disconnected'
					return
				}
				const found = findOwner(info, def.id, def.id)
				if (found?.owner.def.id === def.id) {
					buildInfo.value = info
					unidentified.value = false
					logIdentity(info, found.fallback)
					lastPortId.value = serialPortId(c.port)
					return
				}
				await c.close()
				const name = info.machineName ?? '(unnamed)'
				if (!found) {
					lastError.value = `Controller "${name}" doesn't match "${fluidncName.value}" — disconnected`
				} else if (found.owner.hasClient()) {
					lastError.value = `That controller is "${name}", but the ${found.owner.def.label} is already connected — disconnected`
				} else {
					lastError.value = `That controller is "${name}" — handed it to the ${found.owner.def.label}`
				}
				pushLog('sys', lastError.value)
				// It answers now, so discovery puts it where it belongs.
				void discoverSerialPorts()
			} finally {
				confirming = false
			}
		}

		registrations.set(def.id, {
			def,
			name: () => fluidncName.value || undefined,
			adopt,
			hasClient: () => client.value !== null,
			port: () => client.value?.port,
			notify: message => {
				lastError.value = notice = message
			},
			clearNotice: () => {
				if (notice !== null && lastError.value === notice) lastError.value = null
				notice = null
			},
			lastPortId: () => lastPortId.value,
		})

		// Silent reconnect on startup (no user gesture needed for paired ports).
		void discoverSerialPorts()

		// Editing the expected name may make a previously rejected port match.
		watch(fluidncName, () => {
			resetRejections(FAMILY_ID)
			void discoverSerialPorts()
		})

		//----------------------------------------------------------------------
		// Connection

		/** Prompt for a port (needs a user gesture) and identify it. */
		async function connect() {
			if (client.value || connecting.value) return
			connecting.value = true
			lastProbe = null
			try {
				const result = await requestSerialPort({
					...family,
					probe: port => probe(port, def.id),
				})
				const found = getLastProbe()
				switch (result.status) {
					case 'cancelled':
						break
					case 'owned':
						lastError.value = serialRequestError(result)
						break
					case 'rejected':
						lastError.value = found?.name
							? `Controller "${found.name}" doesn't match "${fluidncName.value}"`
							: serialRequestError(result)
						break
					case 'adopted':
						if (client.value) break
						if (result.family.id !== FAMILY_ID) {
							lastError.value = `That port is the ${result.family.label} — connected it there`
						} else if (found?.ownerId) {
							const other = registrations.get(found.ownerId)
							lastError.value = `That controller is "${found.name}" — connected it as ${other?.def.label ?? found.ownerId}`
						}
						break
				}
			} catch (e) {
				lastError.value = e instanceof Error ? e.message : String(e)
			} finally {
				connecting.value = false
			}
		}

		async function disconnect() {
			const c = client.value
			if (!c) return
			await c.close()
		}

		function requireClient(): FluidNCClient {
			const c = client.value
			if (!c) throw new FluidNCError('disconnected', undefined, `${def.label} is not connected`)
			return c
		}

		/** The client for line commands: not before the controller is known. */
		function requireIdentified(): FluidNCClient {
			const c = requireClient()
			if (unidentified.value) {
				throw new FluidNCError(
					'disconnected',
					undefined,
					`${def.label} is in ${state.value ?? 'Hold'} and not identified yet — ${state.value === 'Alarm' ? 'reset it (Ctrl-X)' : 'resume or reset it'} first`
				)
			}
			return c
		}

		//----------------------------------------------------------------------
		// Commands

		/**
		 * Homing (`$H`, `$HX`, `$H=XZ`) answers `ok` only when the cycle is
		 * done, which can take well over the default command timeout (10 s,
		 * meant to catch a dead link). Give those lines no timeout: a failed
		 * cycle still rejects through `ALARM:N`, a lost port through
		 * 'disconnected'.
		 */
		function isHomingLine(line: string) {
			return /^\$H/i.test(line.trim())
		}

		async function send(line: string, opts: SendOptions = {}) {
			try {
				const timeout = opts.timeout ?? (isHomingLine(line) ? 0 : undefined)
				return await requireIdentified().send(line, {...opts, timeout})
			} catch (e) {
				lastError.value = e instanceof Error ? e.message : String(e)
				throw e
			}
		}

		async function stream(lines: readonly string[], opts: StreamOptions = {}) {
			const c = requireIdentified()
			busy.value = true
			streamProgress.value = {index: 0, total: lines.length}
			try {
				await c.stream(lines, {
					...opts,
					onProgress: p => {
						streamProgress.value = {index: p.index + 1, total: p.total}
						opts.onProgress?.(p)
					},
				})
			} catch (e) {
				lastError.value = e instanceof Error ? e.message : String(e)
				throw e
			} finally {
				busy.value = false
				streamProgress.value = null
			}
		}

		function jog(axes: AxesPosition, opts: Partial<JogOptions> = {}) {
			return send(jogLine(axes, {feed: opts.feed ?? jogFeed.value, ...opts}))
		}

		/** Jog one axis by ±jogStep. */
		function jogStepAxis(axis: Axis, sign: 1 | -1) {
			return jog({[axis]: sign * jogStep.value})
		}

		function jogCancel() {
			return requireClient().jogCancel()
		}

		/**
		 * Home everything (`$H`: the controller's homing cycles, in their
		 * order) or the given steps, one after another (each answers `ok` when
		 * it is done): an axis alone, or several axes at once.
		 */
		async function home(steps?: HomingSteps) {
			busy.value = true
			try {
				if (!steps?.length) await send('$H')
				else for (const line of homingLines(steps)) await send(line)
			} finally {
				busy.value = false
			}
		}

		async function unlock() {
			await send('$X')
			alarm.value = null
		}

		async function reset() {
			await requireClient().softReset()
			busy.value = false
			streamProgress.value = null
		}

		/** Reboot the controller (`$Bye`). The port stays open; the board
		 * comes back with its banner (→ 'reset' event) a few seconds later. */
		async function restart() {
			const c = requireClient()
			busy.value = false
			streamProgress.value = null
			pushLog('sys', 'Restarting the controller ($Bye)…')
			try {
				await c.restart()
			} catch (e) {
				lastError.value = e instanceof Error ? e.message : String(e)
				throw e
			}
		}

		/**
		 * Make the current position read as `axes` in the work coordinate
		 * system (`G10 L20 P<slot>`): the CNC-panel "zero X here" / "set X to
		 * value" — only the offset changes, nothing moves.
		 */
		function setWorkPosition(
			axes: AxesPosition,
			slot: 1 | 2 | 3 | 4 | 5 | 6 = 1
		) {
			const words = axesWords(axes)
			if (!words) return Promise.resolve([] as string[])
			return send(`G10 L20 P${slot} ${words}`)
		}

		/** Zero the given axes (default: all of this machine's) here. */
		function zeroWork(axes: readonly Axis[] = def.axes) {
			const target: AxesPosition = {}
			for (const a of axes) target[a] = 0
			return setWorkPosition(target)
		}

		/** Rapid to work-coordinate positions (default: 0 on the given axes). */
		async function goToWork(
			axes: readonly Axis[] = def.axes,
			values: AxesPosition = {},
			opts: {signal?: AbortSignal} = {}
		) {
			const target: AxesPosition = {}
			for (const a of axes) target[a] = values[a] ?? 0
			const words = axesWords(target)
			if (!words) return
			await send(`G90 G0 ${words}`)
			await waitIdle({signal: opts.signal})
		}

		function feedHold() {
			return requireClient().feedHold()
		}

		/** Spindle stop while held (0x9E). Only meaningful right after feedHold. */
		function spindleStop() {
			return requireClient().spindleStopToggle()
		}

		function resume() {
			return requireClient().cycleStart()
		}

		/**
		 * Feed override (real-time, applies to the running program at once):
		 * 0 = back to 100 %, else ±10 / ±1 %. The controller clamps to 10–200 %
		 * and echoes the value in `Ov:` → `override`.
		 */
		async function feedOverride(step: FeedOverrideStep) {
			await requireClient().feedOverride(step)
			await requireClient().requestStatus()
		}

		/** Rapid (G0) override: 100 / 50 / 25 %. */
		async function rapidOverride(percent: RapidOverride) {
			await requireClient().rapidOverride(percent)
			await requireClient().requestStatus()
		}

		/**
		 * Feed override to `percent` (10–200): the real-time ±10 / ±1 steps from
		 * the value last reported, or from 100 after a reset to it if none has
		 * been. Applies to the running program at once, like `feedOverride`.
		 */
		async function setFeedOverride(percent: number) {
			const c = requireClient()
			const target = Math.round(Math.min(200, Math.max(10, percent)))
			let from = override.value?.feed
			if (from === undefined) {
				await c.feedOverride(0)
				from = 100
			}
			let delta = target - from
			if (delta === 0) return
			// Ahead of the echo, so the next step of a drag starts from here.
			if (override.value) override.value = {...override.value, feed: target}
			const sign = Math.sign(delta) as 1 | -1
			for (; Math.abs(delta) >= 10; delta -= sign * 10) await c.feedOverride((sign * 10) as 10 | -10)
			for (; delta !== 0; delta -= sign) await c.feedOverride(sign)
			await c.requestStatus()
		}

		/**
		 * Run the spindle by hand at `spindleTestSpeed` (M3 S…), or stop it (M5).
		 * A refused line (`error:N`) leaves it as it was.
		 */
		async function setSpindle(on: boolean) {
			const before = spindleOn.value
			try {
				await send(on ? `M3 S${Math.round(spindleTestSpeed.value)}` : 'M5')
			} catch (e) {
				spindleOn.value = before
				throw e
			}
		}

		/** Apply a new speed to the running spindle. */
		async function applySpindleSpeed() {
			if (spindleOn.value) await setSpindle(true)
		}

		/**
		 * Switch a coolant output: M8 (flood) / M7 (mist) on, M9 off. M9 turns
		 * both off — Grbl has no per-output off — so the other one is re-sent
		 * if it was on. Goes through the line queue, like any G-code; the
		 * `sent` handler updates `coolant` as each line goes out.
		 */
		async function setCoolant(which: keyof CoolantState, on: boolean) {
			const other: keyof CoolantState = which === 'flood' ? 'mist' : 'flood'
			const keepOther = !on && coolant.value[other]
			await send(on ? (which === 'flood' ? 'M8' : 'M7') : 'M9')
			if (keepOther) await send(other === 'flood' ? 'M8' : 'M7')
		}

		function waitIdle(opts?: WaitOptions & {settle?: number}) {
			return requireClient().waitIdle(opts)
		}

		/**
		 * Absolute move in machine coordinates (G53) and wait until the machine
		 * is idle again.
		 */
		async function moveTo(
			target: AxesPosition,
			opts: {feed?: number; signal?: AbortSignal; timeout?: number} = {}
		) {
			await send(machineMoveLine(target, opts.feed))
			await waitIdle({signal: opts.signal, timeout: opts.timeout})
		}

		/** Where the controller is plugged in ("#2 · CP210x 10c4:ea60"). */
		const portLabel = computed(() =>
			client.value ? serialPortLabel(client.value.port) : null
		)

		return {
			def,
			fluidncName,
			jogFeed,
			jogStep,
			client,
			connected,
			portLabel,
			unidentified: readonly(unidentified),
			connecting: readonly(connecting),
			status: readonly(status),
			state,
			mpos,
			wpos,
			wco,
			isIdle,
			pins,
			buildInfo: readonly(buildInfo),
			alarm: readonly(alarm),
			lastError,
			log: readonly(log),
			busy: readonly(busy),
			streamProgress: readonly(streamProgress),
			override: readonly(override),
			coolant: readonly(coolant),
			spindleOn: readonly(spindleOn),
			spindleTestSpeed,
			setSpindle,
			applySpindleSpeed,
			setFeedOverride,
			connect,
			disconnect,
			send,
			stream,
			jog,
			jogStepAxis,
			jogCancel,
			home,
			unlock,
			reset,
			restart,
			feedHold,
			spindleStop,
			resume,
			feedOverride,
			rapidOverride,
			setCoolant,
			waitIdle,
			moveTo,
			setWorkPosition,
			zeroWork,
			goToWork,
		}
	})
}

export type MachineStore = ReturnType<ReturnType<typeof defineMachineStore>>
