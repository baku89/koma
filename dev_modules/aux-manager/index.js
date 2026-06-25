const {spawn, exec} = require('node:child_process')
const readline = require('node:readline')
const path = require('node:path')

const {killPTPProcess} = require('./kill-ptpcamera')
const {sendOsc, osc} = require('./osc')
const {sendDmx} = require('./dmx')
const {VectorOneEuro, QuaternionOneEuro, PoseGate} = require('./smoothing')
const chalk = require('chalk')

console.clear()
process.stdout.cursorTo(0, 0)
process.stdout.write('┌──────────────────┐\n')
process.stdout.write('│ Koma Aux Manager │\n')
process.stdout.write('└──────────────────┘\n')

killPTPProcess()

// Send DMX
osc.on('*', e => {
	const {address, args} = e
	const [value] = args

	if (!address.startsWith('/dmx')) {
		return
	}

	const channel = parseInt(address.slice(4))

	sendDmx(channel, value)
})

// ──────────────────────────────────────────────────────────────
// Vive Tracker via libsurvive (replaces node-openvr / SteamVR)
//
// We spawn `survive-cli --record-stdout` (built with the HIDAPI backend,
// see dev_modules/libsurvive/README.md) and parse its stdout. SteamVR is
// not used at all, so this runs natively on Apple Silicon.
//
// survive-cli emits one record per line: "<ts> <codename> <TYPE> <args...>"
//   POSE     : <ts> <codename> POSE     x y z qw qx qy qz
//   VELOCITY : <ts> <codename> VELOCITY vx vy vz wx wy wz
//
// To keep the OSC output identical to the node-openvr era ("original
// format"), aux-manager takes responsibility for the conversion:
//   - position / velocity are in meters (same as OpenVR)
//   - the quaternion is reordered from libsurvive's [w,x,y,z] to linearly's
//     [x,y,z,w] order, which is what the app (src/stores/auxDevices.ts)
//     expects.
// The world origin is the reference base station, so the in-app origin
// calibration (originMatrix) must be re-run — exactly as SteamVR room setup
// was required before. The schema (addresses / arg types) is unchanged.
// ──────────────────────────────────────────────────────────────

const SURVIVE_CLI = path.join(__dirname, '../libsurvive/install/bin/survive-cli')

const REFRESH_RATE = 60 // Max OSC send rate [Hz]
const TRACKER_TIMEOUT = 500 // Mark a tracker disabled if no POSE within [ms]

// One Euro smoothing to kill the tracker jitter ("プルプル"), especially with a
// single base station. Lower MIN_CUTOFF = smoother at rest; higher BETA = less
// lag while moving. Position is in meters, so BETA needs to be large (O(10)).
// Measured tradeoff (against ±2mm synthetic noise @162Hz):
//   (min, beta) = (0.4, 0.02) -> jitter ±0.03mm / lag 394ms   (too laggy)
//                 (1.0, 10)   -> jitter ±0.10mm / lag  56ms   (default)
//                 (1.0, 30)   -> jitter ±0.12mm / lag  27ms   (snappier)
// All jitter values are sub-0.2mm (invisible), so tune mainly for lag.
// Tune live without editing code via env vars, e.g.
//   KOMA_TRACKER_MINCUTOFF=1.0 KOMA_TRACKER_BETA=30 yarn aux
// Set KOMA_TRACKER_SMOOTHING=0 to disable smoothing entirely (raw pose).
// Master passthrough switch: RAW=1 (or `yarn raw`) sends the tracker pose
// straight through — no smoothing, no outlier gate. Handy once calibration is
// solid and you want to judge the raw signal, or to rule the filters out while
// debugging. The individual KOMA_TRACKER_SMOOTHING / _REJECT switches still work
// for granular control; RAW just forces both off.
const RAW = process.env.RAW === '1'

const SMOOTHING = process.env.KOMA_TRACKER_SMOOTHING !== '0' && !RAW
const MIN_CUTOFF = Number(process.env.KOMA_TRACKER_MINCUTOFF ?? 1.0)
const BETA = Number(process.env.KOMA_TRACKER_BETA ?? 10)

// Outlier gate — drop physically-impossible jumps (a bad libsurvive solve from
// occlusion / IR reflection / single-base-station ambiguity) *before* they reach
// the smoothing filter. One Euro can't reject spikes on its own; see smoothing.js.
// Tune live, e.g. KOMA_TRACKER_MAXSPEED=4 KOMA_TRACKER_MAXANGSPEED=720 yarn aux
// Set KOMA_TRACKER_REJECT=0 to disable the gate (raw → filter, as before).
const REJECT = process.env.KOMA_TRACKER_REJECT !== '0' && !RAW
const MAX_LINEAR_SPEED = Number(process.env.KOMA_TRACKER_MAXSPEED ?? 4) // m/s
const MAX_ANGULAR_SPEED =
	(Number(process.env.KOMA_TRACKER_MAXANGSPEED ?? 720) * Math.PI) / 180 // rad/s
const MAX_REJECT = Number(process.env.KOMA_TRACKER_MAXREJECT ?? 8)

// Recalibration. libsurvive normally loads the solved lighthouse positions from
// ~/.config/libsurvive/config.json and locks fast. After moving a base station
// (or when the saved calibration is corrupt — e.g. a -20m floor offset), that
// saved pose is stale and the solver diverges. `RECAL=1` (or `yarn recal`) passes
// --force-calibrate so libsurvive re-solves lighthouse positions from scratch;
// on a clean exit (Ctrl+C) the new, good calibration is written back.
const RECALIBRATE = process.env.RECAL === '1'

// Pose health / "calibration done" detection. Counting base stations from this
// rig's libsurvive output isn't possible (it emits no LH* pose), so judge
// reliability directly from the pose: a solved pose sits within a room-scale
// radius of the origin, whereas the uncalibrated IMU-only divergence runs away
// to ~20 m+. `calibSaneStart` is the timestamp the pose entered the sane radius
// (null whenever the latest pose is outside it); staying sane for CALIB_STABLE_MS
// means calibration has converged and it's safe to Ctrl+C to save.
const CALIB_SANE_RADIUS = Number(process.env.KOMA_TRACKER_SANE_RADIUS ?? 10) // [m]
const CALIB_STABLE_MS = 3000
let calibSaneStart = null

// codename (e.g. 'WM0', 'T20') -> tracker index. Base stations ('LH*') are
// skipped so tracker indices match the node-openvr behaviour.
const trackerIndices = new Map()

function trackerIndexOf(codename) {
	if (codename.startsWith('LH')) return null
	if (!trackerIndices.has(codename)) {
		trackerIndices.set(codename, trackerIndices.size)
	}
	return trackerIndices.get(codename)
}

// index -> latest values; sent only when changed (cf. the old isEqual check).
const state = new Map()

// Base stations (lighthouses) the poser has solved. libsurvive emits their own
// pose under codenames 'LH0', 'LH1', … — a 'LH*' POSE line means that station is
// localized and actively used for tracking. Tracking with a single base station
// is far less stable (no redundancy against occlusion / reflection), so surface
// the live count for debugging. codename -> last-seen timestamp [ms].
// codename -> last-POSE timestamp [ms]. Counted by a *liveness window*, NOT
// sticky: a base station that stops emitting POSE (powered off, occluded, lost
// lock) must drop out of the count. The window must be longer than the gap
// between a connected station's POSE updates; tune via KOMA_TRACKER_BS_TIMEOUT.
const baseStations = new Map()
const BASE_STATION_TIMEOUT = Number(process.env.KOMA_TRACKER_BS_TIMEOUT ?? 2500) // [ms]

function liveBaseStationCount() {
	const now = Date.now()
	let n = 0
	for (const lastSeen of baseStations.values()) {
		if (now - lastSeen < BASE_STATION_TIMEOUT) n++
	}
	return n
}

// KOMA_TRACKER_DEBUG=1 surfaces what libsurvive actually emits, so we can lock
// onto the right "lighthouse is visible now" signal. Row 4 lists only objects
// that emit POSE/VELOCITY (the real tracked things), with per-type counts, so
// startup log/config/OPTION noise doesn't bury them. Row 5 shows one raw POSE
// line verbatim so we can see the exact column layout / codename.
const DEBUG = process.env.KOMA_TRACKER_DEBUG === '1'
const seenRecords = new Map() // codename -> Map(recordType -> count)
let samplePoseLine = null
// recordType -> up to a few raw sample lines, for short measurement types
// (W, B, Y, C, S, …). Lets us see which column carries the lighthouse index,
// since this rig embeds base-station identity in the light records, not in a
// separate LH* pose.
const typeSamples = new Map()

function recordTotal(types) {
	let n = 0
	for (const c of types.values()) n += c
	return n
}

// Startup visibility: libsurvive needs to lock onto the base station(s) before
// it emits any POSE (tens of seconds on a cold start, esp. with one station).
let surviveStartedAt = Date.now()
let lastSurviveLog = ''

function trackerState(index) {
	if (!state.has(index)) {
		state.set(index, {
			position: null,
			rotation: null,
			velocity: null,
			enabled: false,
			lastSeen: 0,
			sent: {},
			posFilter: new VectorOneEuro(3, MIN_CUTOFF, BETA),
			rotFilter: new QuaternionOneEuro(MIN_CUTOFF, BETA),
			gate: new PoseGate({
				maxLinearSpeed: MAX_LINEAR_SPEED,
				maxAngularSpeed: MAX_ANGULAR_SPEED,
				maxReject: MAX_REJECT,
			}),
		})
	}
	return state.get(index)
}

function handleLine(line) {
	const t = line.trim().split(/\s+/)
	if (t.length < 3) return

	const type = t[2]

	if (DEBUG) {
		let rec = seenRecords.get(t[1])
		if (!rec) seenRecords.set(t[1], (rec = new Map()))
		rec.set(type, (rec.get(type) ?? 0) + 1)
		// Keep the *latest* POSE so its row is a live monitor — watch the position
		// settle from the garbage z≈20m to sane sub-meter values as calibration
		// converges.
		if (type === 'POSE') samplePoseLine = line.trim()
		// Collect a handful of raw samples for short measurement record types
		// (W, B, Y, C, S, A, L, i …) — but not POSE/VELOCITY/OPTION-name noise —
		// so we can decode which column is the lighthouse index.
		if (/^[A-Za-z]{1,3}$/.test(type)) {
			let arr = typeSamples.get(type)
			if (!arr) typeSamples.set(type, (arr = []))
			if (arr.length < 4) arr.push(line.trim())
		}
	}

	// Base stations (lighthouses) appear under 'LH*' codenames. Count only on a
	// fresh POSE — a *live* signal that the station is currently being solved.
	// (Counting on any record type, or counting sticky, falsely keeps a station
	// that is powered off: libsurvive restores last session's calibration from
	// ~/.config/libsurvive/config.json, so a stale 'LH0' shows up at startup.)
	// Then stop: a lighthouse is not a tracker and must not get a /trackerN index.
	if (t[1].startsWith('LH')) {
		if (type === 'POSE') baseStations.set(t[1], Date.now())
		return
	}

	if (type !== 'POSE' && type !== 'VELOCITY') return

	const index = trackerIndexOf(t[1])
	if (index === null) return

	const s = trackerState(index)

	if (type === 'POSE') {
		// libsurvive: x y z  qw qx qy qz
		const v = t.slice(3, 10).map(Number)
		if (v.some(Number.isNaN)) return
		const [x, y, z, qw, qx, qy, qz] = v

		let position = [x, y, z]
		let rotation = [qx, qy, qz, qw] // -> linearly [x,y,z,w]

		// libsurvive's own record timestamp [s] is the time base for both the
		// outlier gate and the smoothing filter.
		const ts = Number(t[0])

		// Drop physically-impossible spikes before they pollute the filter or
		// the published pose. The last good pose is held until a sane sample
		// (or the resync cap) arrives.
		if (REJECT && !s.gate.accept(position, rotation, ts)) {
			return
		}

		if (SMOOTHING) {
			position = s.posFilter.filter(position, ts)
			rotation = s.rotFilter.filter(rotation, ts)
		}

		s.position = position
		s.rotation = rotation
		s.enabled = true
		s.lastSeen = Date.now()

		// Track pose health: sane (within room-scale radius) vs IMU-only runaway.
		const mag = Math.hypot(position[0], position[1], position[2])
		if (mag < CALIB_SANE_RADIUS) {
			if (calibSaneStart === null) calibSaneStart = Date.now()
		} else {
			calibSaneStart = null
		}
	} else {
		// VELOCITY: vx vy vz  wx wy wz (linear part only)
		const v = t.slice(3, 6).map(Number)
		if (v.some(Number.isNaN)) return
		s.velocity = v
		s.lastSeen = Date.now()
	}
}

function sendIfChanged(s, address, args) {
	const key = JSON.stringify(args)
	if (s.sent[address] === key) return
	s.sent[address] = key
	sendOsc(address, ...args)
}

function flush() {
	const now = Date.now()

	for (const [index, s] of state) {
		if (now - s.lastSeen >= TRACKER_TIMEOUT) {
			s.enabled = false
		}

		// `enabled` is a latched state, not an edge event: send it every flush
		// (not just on change) so clients that connect/reload late — e.g. the
		// browser over the non-retaining OSC bridge — still receive it.
		sendOsc(`/tracker${index}/enabled`, s.enabled)
		if (s.position) sendIfChanged(s, `/tracker${index}/position`, s.position)
		if (s.rotation) sendIfChanged(s, `/tracker${index}/rotation`, s.rotation)
		if (s.velocity) sendIfChanged(s, `/tracker${index}/velocity`, s.velocity)
	}

	process.stdout.cursorTo(0, 3)
	process.stdout.clearLine(1)
	const n = trackerIndices.size
	const bs = liveBaseStationCount()
	const bsTail =
		bs > 0
			? chalk.cyan(`  ${bs} base station${bs > 1 ? 's' : ''}`) +
				(bs === 1 ? chalk.yellow(' ⚠ single — unstable') : '')
			: ''
	if (n === 0) {
		const secs = Math.floor((Date.now() - surviveStartedAt) / 1000)
		const tail = lastSurviveLog ? `  ${chalk.dim(lastSurviveLog.slice(0, 60))}` : ''
		const recal = RECALIBRATE
			? chalk.magenta('  [RECAL — move the tracker slowly through the volume]')
			: ''
		process.stdout.write(`* Acquiring tracking… ${secs}s${recal}${bsTail}${tail}\n`)
	} else {
		const rejected = REJECT
			? [...state.values()].reduce((sum, s) => sum + (s.gate?.rejectedTotal ?? 0), 0)
			: 0
		const rejTail = rejected ? chalk.dim(`  (${rejected} outliers dropped)`) : ''

		// Reliability is judged from pose health, not the (un-countable on this
		// rig) base-station number. Sane = within room radius; runaway ≈ 20 m+.
		const healthy = calibSaneStart !== null
		const stable = healthy && Date.now() - calibSaneStart > CALIB_STABLE_MS

		let statusTail
		if (!healthy) {
			statusTail = chalk.red(
				'  ⚠ pose diverging (uncalibrated) — run `yarn recal`'
			)
		} else if (RECALIBRATE) {
			statusTail = stable
				? chalk.green('  ✓ CALIBRATED & stable — Ctrl+C to save')
				: chalk.magenta('  [RECAL — keep moving slowly; stabilizing…]')
		} else {
			const filterTag = RAW
				? chalk.dim('  (raw: no smoothing/gate)')
				: !SMOOTHING || !REJECT
					? chalk.dim(
							`  (${[!SMOOTHING && 'no-smooth', !REJECT && 'no-gate'].filter(Boolean).join(',')})`
						)
					: ''
			statusTail = chalk.green('  ✓ pose OK') + (bs > 0 ? bsTail : '') + filterTag
		}

		process.stdout.write(
			chalk.bold(`* ${n} Tracker Detected`) + statusTail + rejTail + '\n'
		)
	}

	if (DEBUG) {
		// Only objects that emit POSE/VELOCITY — sorted by record count — so
		// startup log / OPTION noise doesn't bury the actual tracked objects.
		const dataEntries = [...seenRecords.entries()]
			.filter(([, types]) => types.has('POSE') || types.has('VELOCITY'))
			.sort((a, b) => recordTotal(b[1]) - recordTotal(a[1]))
		const dump = dataEntries.length
			? dataEntries
					.map(
						([cn, types]) =>
							`${cn}:${[...types.entries()].map(([ty, c]) => `${ty}×${c}`).join(',')}`
					)
					.join('  ')
			: '(no POSE/VELOCITY yet — nothing is being tracked)'

		process.stdout.cursorTo(0, 4)
		process.stdout.clearLine(1)
		process.stdout.write(chalk.dim(`data → ${dump}`.slice(0, 200)) + '\n')

		let row = 5
		process.stdout.cursorTo(0, row++)
		process.stdout.clearLine(1)
		const sample = samplePoseLine
			? `POSE(live) → ${samplePoseLine}`.slice(0, 160)
			: 'POSE(live) → (none yet)'
		process.stdout.write(chalk.dim(sample) + '\n')

		// Raw samples of the short measurement records, one per row, so we can
		// see the column layout (and spot the lighthouse-index column, whose
		// value should vary across base stations, e.g. 0 vs 1).
		for (const [ty, arr] of typeSamples) {
			for (const s of arr) {
				if (row > 18) break
				process.stdout.cursorTo(0, row++)
				process.stdout.clearLine(1)
				process.stdout.write(chalk.dim(`${ty} → ${s}`.slice(0, 160)) + '\n')
			}
			if (row > 18) break
		}
	}
}

setInterval(flush, 1000 / REFRESH_RATE)

let surviveChild = null
let shuttingDown = false

function startSurvive() {
	surviveStartedAt = Date.now()

	const surviveArgs = ['--record-stdout']
	if (RECALIBRATE) {
		// Explicit value form ('--force-calibrate', '1') so libsurvive's arg
		// parser can't swallow the following flag as this option's value.
		surviveArgs.push('--force-calibrate', '1')
		// Buzz the tracker the moment libsurvive solves the lighthouse positions,
		// so "when is calibration done?" has a physical answer you can feel.
		surviveArgs.push('--haptic-on-calibrate', '1')
	}

	surviveChild = spawn(SURVIVE_CLI, surviveArgs, {
		stdio: ['ignore', 'pipe', 'pipe'],
	})

	const rl = readline.createInterface({input: surviveChild.stdout})
	rl.on('line', handleLine)

	// Surface libsurvive's own progress (base station discovery, sync, …) which
	// it logs to stderr, so the acquisition phase is visible instead of silent.
	const rlErr = readline.createInterface({input: surviveChild.stderr})
	rlErr.on('line', line => {
		const l = line.trim()
		if (l) lastSurviveLog = l
	})

	surviveChild.on('error', err => {
		process.stdout.cursorTo(0, 3)
		process.stdout.clearLine(1)
		process.stdout.write(
			chalk.red(`* Cannot start survive-cli: ${err.message}\n`)
		)
	})

	surviveChild.on('exit', code => {
		rl.close()
		rlErr.close()
		if (shuttingDown) return
		process.stdout.cursorTo(0, 3)
		process.stdout.clearLine(1)
		process.stdout.write(
			chalk.yellow(`* survive-cli exited (${code}); restarting in 1s…\n`)
		)
		setTimeout(startSurvive, 1000)
	})
}

// Reap any orphaned survive-cli from a previous session BEFORE we spawn ours.
// libsurvive holds the tracker's HID device and runs the disambiguator/solver;
// a leftover process (the parent was force-quit / crashed / its terminal closed
// instead of a clean Ctrl+C, so the child was never reaped) pegs a CPU core and
// can starve the new process of sensor data — the tracker then never produces a
// POSE and the UI sits on "Acquiring tracking…" forever, which is exactly the
// intermittent "sometimes it never detects" symptom. Same idea as
// killPTPProcess() for the camera. SIGINT first so a still-running one can flush
// its calibration to config.json, then SIGKILL any straggler before we start.
function killStaleSurvive(done) {
	exec("pgrep -f 'survive-cli'", (_err, stdout) => {
		const pids = (stdout || '')
			.split('\n')
			.map(s => s.trim())
			.filter(Boolean)
			.filter(pid => Number(pid) !== process.pid)
		if (pids.length === 0) return done()
		process.stdout.cursorTo(0, 3)
		process.stdout.clearLine(1)
		process.stdout.write(
			chalk.yellow(
				`* Reaping ${pids.length} leftover survive-cli process${pids.length > 1 ? 'es' : ''}…\n`
			)
		)
		for (const pid of pids) {
			try {
				process.kill(Number(pid), 'SIGINT')
			} catch {
				/* already gone */
			}
		}
		// Give survive_close() a moment to write config, then force-kill survivors.
		setTimeout(() => {
			for (const pid of pids) {
				try {
					process.kill(Number(pid), 'SIGKILL')
				} catch {
					/* exited cleanly on SIGINT */
				}
			}
			done()
		}, 1500)
	})
}

killStaleSurvive(startSurvive)

function shutdown() {
	if (shuttingDown) return
	shuttingDown = true
	process.stdout.write('\nExiting (persisting libsurvive calibration)…\n')
	if (surviveChild) {
		// SIGINT (not SIGTERM) lets survive-cli run survive_close(), which writes
		// the solved lighthouse calibration / OOTX to ~/.config/libsurvive/config.json.
		// Wait for it to flush so the next start skips the slow cold calibration.
		surviveChild.once('exit', () => process.exit(0))
		surviveChild.kill('SIGINT')
		setTimeout(() => process.exit(0), 5000) // safety net
	} else {
		process.exit(0)
	}
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
// Terminal closed / parent died: still try the clean (calibration-saving) path.
process.on('SIGHUP', shutdown)
// Last-resort backstop: if we exit by any path that didn't reap the child
// (uncaught crash, the 5s safety net firing while survive-cli is wedged), make
// sure we never leave an orphan holding the HID device. process.on('exit') is
// synchronous-only, so kill() here is the strongest thing we can do.
process.on('exit', () => {
	if (surviveChild && surviveChild.exitCode === null && !surviveChild.killed) {
		try {
			surviveChild.kill('SIGKILL')
		} catch {
			/* already gone */
		}
	}
})
process.on('uncaughtException', err => {
	process.stdout.write(chalk.red(`\nFatal: ${err.stack || err}\n`))
	shutdown()
})
