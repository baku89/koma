const openvr = require('../node-openvr')
const OSC = require('osc-js')
const {isEqual} = require('lodash')
const {mat4} = require('linearly')
const fps = require('fps')

const REFRESH_RATE = 60

const osc = new OSC({plugin: new OSC.WebsocketServerPlugin()})
osc.open()

const vr = openvr.VR_Init(openvr.EVRApplicationType.Other)

setInterval(updatePoses, 1000 / REFRESH_RATE)

function updatePoses() {
	console.clear()

	const poses = vr.GetDeviceToAbsoluteTrackingPose(
		openvr.ETrackingUniverseOrigin.Standing,
		0
	)

	const trackerIndices = vr.GetSortedTrackedDeviceIndicesOfClass(
		openvr.ETrackedDeviceClass.GenericTracker
	)

	const trackers = trackerIndices.map(i => poses[i])

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

	ticker.tick()

	const mat = mat4.transpose([
		...tracker.deviceToAbsoluteTracking.flat(),
		...[0, 0, 0, 1],
	])

	const position = mat4.getTranslation(mat)
	const rotation = mat4.getRotation(mat)
	const velocity = tracker.velocity
	const enabled = tracker.trackingResult === openvr.ETrackingResult.Running_OK

	console.log('Tracker: %d (fps %d)', index, Math.round(ticker.rate))
	console.log('Position= [%o, %o, %o]', ...position)
	console.log('Rotation= [%o, %o, %o, %o]', ...rotation)
	console.log('Velocity= [%o, %o, %o]', ...tracker.velocity)

	osc.send(new OSC.Message(`/tracker${index}/position`, ...position))
	osc.send(new OSC.Message(`/tracker${index}/velocity`, ...velocity))
	osc.send(new OSC.Message(`/tracker${index}/rotation`, ...rotation))
	osc.send(new OSC.Message(`/tracker${index}/enabled`, enabled))

	prevTrackers[index] = tracker
}
