const openvr = require('../node-openvr')

const {isEqual} = require('lodash')
const {mat4} = require('linearly')
const fps = require('fps')
const {killPTPProcess} = require('./kill-ptpcamera')
const {sendOsc} = require('./osc')
const chalk = require('chalk')

console.clear()
process.stdout.cursorTo(0, 0)
process.stdout.write('┌──────────────────┐\n')
process.stdout.write('│ Koma Aux Manager │\n')
process.stdout.write('└──────────────────┘\n')

// killPTPProcess()

const REFRESH_RATE = 60

function handleOpenVRTarcker() {
	let vr

	try {
		vr = openvr.VR_Init(openvr.EVRApplicationType.Other)
	} catch (e) {
		console.error('Cannot open the OpenVR tracker. Is SteamVR running?')
		return
	}

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

		process.stdout.cursorTo(0, 3)
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

		process.stdout.cursorTo(0, 3)
		process.stdout.clearLine(1)
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
}
handleOpenVRTarcker()

setInterval(() => null, 10000)
