const {spawn} = require('node:child_process')
const readline = require('node:readline')
const path = require('node:path')

const {killPTPProcess} = require('./kill-ptpcamera')
const {sendOsc, osc} = require('./osc')
const {sendDmx} = require('./dmx')
const {VectorOneEuro, QuaternionOneEuro} = require('./smoothing')
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
const SMOOTHING = process.env.KOMA_TRACKER_SMOOTHING !== '0'
const MIN_CUTOFF = Number(process.env.KOMA_TRACKER_MINCUTOFF ?? 1.0)
const BETA = Number(process.env.KOMA_TRACKER_BETA ?? 10)

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
		})
	}
	return state.get(index)
}

function handleLine(line) {
	const t = line.trim().split(/\s+/)
	if (t.length < 3) return

	const type = t[2]
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

		if (SMOOTHING) {
			// Use libsurvive's own record timestamp [s] as the time base.
			const ts = Number(t[0])
			position = s.posFilter.filter(position, ts)
			rotation = s.rotFilter.filter(rotation, ts)
		}

		s.position = position
		s.rotation = rotation
		s.enabled = true
		s.lastSeen = Date.now()
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
	if (n === 0) {
		const secs = Math.floor((Date.now() - surviveStartedAt) / 1000)
		const tail = lastSurviveLog ? `  ${chalk.dim(lastSurviveLog.slice(0, 60))}` : ''
		process.stdout.write(`* Acquiring tracking… ${secs}s${tail}\n`)
	} else {
		process.stdout.write(chalk.bold(`* ${n} Tracker Detected\n`))
	}
}

setInterval(flush, 1000 / REFRESH_RATE)

let surviveChild = null
let shuttingDown = false

function startSurvive() {
	surviveStartedAt = Date.now()
	surviveChild = spawn(SURVIVE_CLI, ['--record-stdout'], {
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

startSurvive()

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
