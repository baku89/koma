const openvr = require('../node-openvr')
const OSC = require('osc-js')
const {isEqual} = require('lodash')
const {mat4} = require('linearly')
const fps = require('fps')
const chalk = require('chalk')
const {killPTPProcess} = require('./kill-ptpcamera')

// killPTPProcess()

const REFRESH_RATE = 60

const osc = new OSC({plugin: new OSC.WebsocketServerPlugin()})
osc.open()

function handleOpenVRTarcker() {
	let vr

	try {
		vr = openvr.VR_Init(openvr.EVRApplicationType.Other)
	} catch (e) {
		console.error('Cannot open the OpenVR tracker. Is SteamVR running?')
		console.error(e)
		return
	}

	console.clear()

	setInterval(updatePoses, 1000 / REFRESH_RATE)

	function updatePoses() {
		const poses = vr.GetDeviceToAbsoluteTrackingPose(
			openvr.ETrackingUniverseOrigin.Standing,
			0
		)

		const trackerIndices = vr.GetSortedTrackedDeviceIndicesOfClass(
			openvr.ETrackedDeviceClass.GenericTracker
		)

		const trackers = trackerIndices.map(i => poses[i])

		process.stdout.cursorTo(0, 0)

		process.stdout.write('┌──────────────────┐\n')
		process.stdout.write('│ Koma Aux Manager │\n')
		process.stdout.write('└──────────────────┘\n')
		process.stdout.write('* No Tracker Detected\n')

		trackers.forEach(updateTracker)
	}

	const prevTrackers = []
	const tickers = []

	function updateTracker(tracker, index) {
		const prevTracker = prevTrackers[index] ?? {}
		const ticker = (tickers[index] ??= fps({every: 10}))

		if (isEqual(tracker, prevTracker)) {
			return
		}

		process.stdout.cursorTo(0, 0)
		process.stdout.clearLine(1)

		process.stdout.cursorTo(0, 3)
		process.stdout.clearLine(1)

		process.stdout.cursorTo(0, 0)

		process.stdout.write('┌──────────────────┐\n')
		process.stdout.write('│ Koma Aux Manager │\n')
		process.stdout.write('└──────────────────┘\n')

		process.stdout.write(
			chalk.bold(`* Tracker: ${chalk.red(index)}`) +
				` (${Math.round(ticker.rate)}fps)\n`
		)

		ticker.tick()

		// The matrix returned from OpenVR lib is 4 x 3 row-major order,
		// while the last row [0, 0, 0, 1] is omitted.
		// In order to use it with linearly, we need to add the last row back,
		// and transpose it.
		const mat = mat4.transpose([
			...tracker.deviceToAbsoluteTracking.flat(),
			...[0, 0, 0, 1],
		])

		const enabled = tracker.trackingResult === openvr.ETrackingResult.Running_OK
		const position = mat4.getTranslation(mat)
		const rotation = mat4.getRotation(mat)
		const velocity = tracker.velocity

		sendOsc(`/tracker${index}/enabled`, enabled)
		sendOsc(`/tracker${index}/position`, ...position)
		sendOsc(`/tracker${index}/velocity`, ...velocity)
		sendOsc(`/tracker${index}/rotation`, ...rotation)

		prevTrackers[index] = tracker
	}

	function sendOsc(address, ...args) {
		osc.send(new OSC.Message(address, ...args))

		printKeyValue(address, printVector(args))
	}

	function printKeyValue(key, value) {
		process.stdout.write(
			'  ' + chalk.redBright(key.padEnd(18, ' ')) + ' = ' + value + '\n'
		)
	}

	function printVector(vec) {
		return vec
			.map(v =>
				chalk.red(typeof v === 'number' ? v.toFixed(3).padStart(6, ' ') : v)
			)
			.join(', ')
	}
}

// handleOpenVRTarcker()

const DMX = require('dmx')

const dmx = new DMX()

const universe = dmx.addUniverse('demo', 'artnet', '10.0.1.30', {})

// universe.updateAll(255)
