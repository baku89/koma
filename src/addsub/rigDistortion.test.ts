import {quat, vec3} from 'linearly'
import {describe, expect, it} from 'vitest'

import {DEFAULT_CALIBRATION} from './config'
import {workAxesToCameraPose,type WorkKinematics} from './kinematics'
import {
	axesFromHeadPose,
	axisDeltas,
	calibratedToWork,
	completeAxes,
	DEFAULT_RIG_DISTORTION,
	deltaAt,
	DISTORTION_DIRECTIONS,
	type DistortionPoint,
	distortionPoints,
	type DistortionSample,
	headPose,
	nominalAxes,
	pointId,
	reticleHalfWidth,
	type RigAxes,
	sampleDelta,
	solveDistortion,
	workToCalibrated,
} from './rigDistortion'

const cal: WorkKinematics = {pupilOffset: [0, 0, -80], rotarySigns: {a: 1, b: 1, c: 1}}
const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps
const nearVec = (a: readonly number[], b: readonly number[], eps = 1e-3) =>
	a.every((v, i) => near(v, b[i], eps))

const DEFAULT_POINTS = distortionPoints(DEFAULT_RIG_DISTORTION)
const ALL_POINTS = distortionPoints({
	radii: [400],
	directions: DISTORTION_DIRECTIONS.map(d => d.id),
	topPans: [0, 90, -90],
	rolls: [0, 90, -45],
})
/** A point by direction (radius default 400, no variant). */
const point = (direction: string, radius = 400, variant: {pan?: number; roll?: number} = {}): DistortionPoint =>
	distortionPoints({
		radii: [radius],
		directions: [direction],
		topPans: [variant.pan ?? 0],
		rolls: [variant.roll ?? 0],
	})[0]

describe('points', () => {
	it('are every chosen direction at every radius, keyed direction@radius', () => {
		const pts = distortionPoints({radii: [400, 250], directions: ['front', 'top'], topPans: [0], rolls: [0]})
		expect(pts.map(p => p.id)).toEqual(['front@400', 'top@400', 'front@250', 'top@250'])
		expect(pointId('right', 300)).toBe('right@300')
		expect(DEFAULT_POINTS.map(p => p.id)).toEqual(['front@400', 'top@400', 'right@400', 'left@400'])
	})

	it('vary the top point by pan and the others by roll', () => {
		const pts = distortionPoints({radii: [400], directions: ['front', 'top'], topPans: [0, 90, -90], rolls: [0, 90, -45]})
		expect(pts.map(p => p.id)).toEqual([
			'front@400', 'front@400/c90', 'front@400/c-45',
			'top@400', 'top@400/b90', 'top@400/b-90',
		])
		const [, f90, , , t90] = pts
		expect(near(nominalAxes(f90, DEFAULT_RIG_DISTORTION, cal).c, 90)).toBe(true)
		// Up at 45°, the roll turns the tilt axis: |roll| ≤ 45° can still look at
		// the base (with another pan / tilt), 90° cannot and is left out.
		const high = distortionPoints({radii: [400], directions: ['frontHigh'], topPans: [0], rolls: [0, 90, -45]})
		expect(high.map(p => p.id)).toEqual(['frontHigh@400', 'frontHigh@400/c-45'])
		const n = nominalAxes(high[1], DEFAULT_RIG_DISTORTION, cal)
		expect(near(n.c, -45)).toBe(true)
		expect(near(n.a, 0) || near(n.b, 0)).toBe(false) // not the roll-0 split
		const top90 = nominalAxes(t90, DEFAULT_RIG_DISTORTION, cal)
		expect(near(top90.b, 90) && near(top90.a, -90) && near(top90.c, 0)).toBe(true)
		// Rolled / panned, it still looks at the base from the same pupil.
		for (const p of [f90, t90, high[1]]) {
			const pose = workAxesToCameraPose(nominalAxes(p, DEFAULT_RIG_DISTORTION, cal), cal)
			const forward = vec3.transformQuat([0, 0, -1], pose.rotation)
			expect(nearVec(forward, vec3.normalize(vec3.sub([0, 120, 0], pose.position)), 1e-6)).toBe(true)
			expect(nearVec(pose.position, vec3.add([0, 120, 0], vec3.scale(p.dir, 400)))).toBe(true)
		}
	})
})

describe('nominal poses', () => {
	const d = {base: [0, 120, 0] as vec3}

	it('puts the pupil radius away along the direction, looking at the base', () => {
		for (const p of [...ALL_POINTS, point('front', 250)]) {
			const axes = nominalAxes(p, d, cal)
			const pose = workAxesToCameraPose(axes, cal)
			const expected = vec3.add(d.base, vec3.scale(p.dir, p.radius))
			expect(nearVec(pose.position, expected)).toBe(true)
			const forward = vec3.transformQuat([0, 0, -1], pose.rotation)
			const toBase = vec3.normalize(vec3.sub(d.base, pose.position))
			// (The head centre is rounded to 3 decimals: ~1e-6 rad at 400 mm.)
			expect(nearVec(forward, toBase, 1e-5)).toBe(true)
			expect(near(axes.c, p.roll)).toBe(true)
		}
	})

	it('front looks −Z with no angles, right pans +90, top tilts −90', () => {
		expect(nominalAxes(point('front'), d, cal)).toMatchObject({a: 0, b: 0, c: 0, x: 0, y: 120})
		expect(near(nominalAxes(point('right'), d, cal).b, 90)).toBe(true)
		expect(near(nominalAxes(point('left'), d, cal).b, -90)).toBe(true)
		const top = nominalAxes(point('top'), d, cal)
		expect(near(top.a, -90)).toBe(true)
		expect(near(top.x, 0) && near(top.z, 0)).toBe(true)
	})

	it('honours the rotary signs', () => {
		const flipped: WorkKinematics = {...cal, rotarySigns: {a: -1, b: -1, c: 1}}
		expect(near(nominalAxes(point('right'), d, flipped).b, -90)).toBe(true)
		expect(near(nominalAxes(point('top'), d, flipped).a, 90)).toBe(true)
	})
})

/** A synthetic error field: translation and world-frame rotation, affine in the head position. */
function trueDelta(p: vec3) {
	return {
		translation: [0.5 + 0.002 * p[0], -1 + 0.001 * p[1], 0.3 - 0.0015 * p[2]] as vec3,
		rotation: [0.1 - 0.0004 * p[1], 0.2 + 0.0003 * p[0], -0.05 + 0.0002 * p[2]] as vec3,
	}
}

function rotVecQuat(v: vec3) {
	const angle = vec3.length(v)
	return angle < 1e-12 ? quat.identity : quat.fromAxisAngle(vec3.scale(v, 1 / angle), angle)
}

/** The axes an operator would end up at for a nominal pose under `trueDelta`. */
function distorted(nominal: RigAxes): RigAxes {
	const pose = headPose(nominal, cal)
	const d = trueDelta(pose.centre)
	return axesFromHeadPose(
		{
			centre: vec3.add(pose.centre, d.translation),
			rotation: quat.mul(rotVecQuat(d.rotation), pose.rotation),
		},
		cal,
		nominal
	)
}

function samplesFor(ids: string[], radius = 400): DistortionSample[] {
	return ids.map(id => {
		const nominal = nominalAxes(point(id, radius), DEFAULT_RIG_DISTORTION, cal)
		return {nominal, actual: distorted(nominal), at: 0}
	})
}

/**
 * A pan axis 3 mm off-centre (e, in the pan frame) and tilted 0.3° about world
 * X: the head is carried round by Ry(pan)·e and turned by δ − Ry(pan)·δ, on
 * top of the affine field.
 */
const ECCENTRIC: vec3 = [3, 0, -2]
const AXIS_TILT: vec3 = [0.3, 0, 0]
function truePanDelta(p: vec3, panDeg: number) {
	const ry = quat.fromAxisAngle([0, 1, 0], panDeg)
	const base = trueDelta(p)
	return {
		translation: vec3.add(base.translation, vec3.transformQuat(ECCENTRIC, ry)),
		rotation: vec3.add(base.rotation, vec3.sub(AXIS_TILT, vec3.transformQuat(AXIS_TILT, ry))),
	}
}
function distortedWithPan(nominal: RigAxes): RigAxes {
	const pose = headPose(nominal, cal)
	const d = truePanDelta(pose.centre, nominal.b)
	return axesFromHeadPose(
		{
			centre: vec3.add(pose.centre, d.translation),
			rotation: quat.mul(rotVecQuat(d.rotation), pose.rotation),
		},
		cal,
		nominal
	)
}
function panSamplesFor(ids: string[], radii: number[]): DistortionSample[] {
	return radii.flatMap(r =>
		ids.map(id => {
			const nominal = nominalAxes(point(id, r), DEFAULT_RIG_DISTORTION, cal)
			return {nominal, actual: distortedWithPan(nominal), at: 0}
		})
	)
}

describe('fit', () => {
	it('returns null without samples and leaves axes alone', () => {
		expect(solveDistortion([], cal)).toBeNull()
		const axes: RigAxes = {x: 1, y: 2, z: 3, a: 4, b: 5, c: 6}
		expect(calibratedToWork(axes, null, cal)).toEqual(axes)
		expect(workToCalibrated(axes, null, cal)).toEqual(axes)
	})

	it('recovers a sample delta as translation + world rotation', () => {
		const [s] = samplesFor(['front'])
		const d = sampleDelta(s, cal)
		const want = trueDelta(headPose(s.nominal, cal).centre)
		expect(nearVec(d.translation, want.translation)).toBe(true)
		expect(nearVec(d.rotation, want.rotation, 1e-3)).toBe(true)
	})

	it('four points determine the affine field exactly', () => {
		const field = solveDistortion(samplesFor(['front', 'top', 'right', 'left']), cal)!
		expect(field.count).toBe(4)
		expect(field.terms.pan).toBe(false)
		expect(field.residual.linear).toBeLessThan(1e-3)
		expect(field.residual.rotary).toBeLessThan(1e-3)
		// Predicts the error somewhere else.
		const p: vec3 = [150, 300, 250]
		const got = deltaAt(field, p, 20, 0)
		const want = trueDelta(p)
		expect(nearVec(got.translation, want.translation, 2e-3)).toBe(true)
		expect(nearVec(got.rotation, want.rotation, 2e-3)).toBe(true)
	})

	it('one point is a constant offset', () => {
		const field = solveDistortion(samplesFor(['front']), cal)!
		const d0 = deltaAt(field, [0, 0, 0], 0, 0)
		const d1 = deltaAt(field, [500, 500, 500], 90, 0)
		expect(nearVec(d0.translation, d1.translation, 1e-9)).toBe(true)
		expect(nearVec(d0.rotation, d1.rotation, 1e-9)).toBe(true)
		const want = trueDelta(headPose(samplesFor(['front'])[0].nominal, cal).centre)
		expect(nearVec(d0.translation, want.translation)).toBe(true)
	})

	it('two points fit along their line and nothing across it', () => {
		const field = solveDistortion(samplesFor(['right', 'left']), cal)!
		const dr = deltaAt(field, [400, 120, 0], 90, 0).translation
		const dl = deltaAt(field, [-400, 120, 0], -90, 0).translation
		const want = (x: number) => trueDelta([x, 120, 0]).translation
		// Along X the two samples are matched (up to the head-centre / pupil offset).
		expect(near(dr[0] - dl[0], want(400)[0] - want(-400)[0], 1e-3)).toBe(true)
		// Moving in Y / Z changes nothing.
		const up = deltaAt(field, [0, 600, 0], 0, 0).translation
		const down = deltaAt(field, [0, -600, 0], 0, 0).translation
		expect(nearVec(up, down, 1e-9)).toBe(true)
	})

	it('calibratedToWork sends the camera to the ideal pose; workToCalibrated reads it back', () => {
		const field = solveDistortion(samplesFor(['front', 'top', 'right', 'left']), cal)!
		const ideal: RigAxes = {x: 120, y: 350, z: 280, a: -20, b: 35, c: 3}
		const work = calibratedToWork(ideal, field, cal)
		// Where the camera really ends up under the true distortion is the ideal pose.
		const actual = headPose(work, cal)
		const d = trueDelta(headPose(ideal, cal).centre)
		const really = {
			centre: vec3.sub(actual.centre, d.translation),
			rotation: quat.mul(quat.invert(rotVecQuat(d.rotation)), actual.rotation),
		}
		expect(nearVec(really.centre, headPose(ideal, cal).centre, 5e-3)).toBe(true)
		expect(quat.angle(really.rotation, headPose(ideal, cal).rotation)).toBeLessThan(5e-3)
		// Round trip.
		const back = workToCalibrated(work, field, cal)
		for (const k of ['x', 'y', 'z', 'a', 'b', 'c'] as const) expect(near(back[k], ideal[k], 2e-3)).toBe(true)
	})

	it('one radius cannot separate a pan-axis error from the position (affine only)', () => {
		const field = solveDistortion(panSamplesFor(['front', 'top', 'right', 'left', 'frontRight', 'frontLeft'], [400]), cal)!
		expect(field.count).toBe(6)
		expect(field.terms.pan).toBe(false)
	})

	it('two radii fit the pan terms and predict a third radius and a new pan', () => {
		const field = solveDistortion(panSamplesFor(['front', 'top', 'right', 'left'], [400, 250]), cal)!
		expect(field.count).toBe(8)
		expect(field.terms.pan).toBe(true)
		expect(field.residual.linear).toBeLessThan(1e-3)
		expect(field.residual.rotary).toBeLessThan(1e-3)
		// Closer in, and at a pan no sample had.
		for (const [id, r] of [['front', 180], ['frontRight', 300], ['left', 500]] as const) {
			const nominal = nominalAxes(point(id, r), DEFAULT_RIG_DISTORTION, cal)
			const pose = headPose(nominal, cal)
			const got = deltaAt(field, pose.centre, nominal.b, 0)
			const want = truePanDelta(pose.centre, nominal.b)
			expect(nearVec(got.translation, want.translation, 5e-3)).toBe(true)
			expect(nearVec(got.rotation, want.rotation, 5e-3)).toBe(true)
		}
		// …which the affine-only fit of the same points gets wrong.
		const affineOnly = solveDistortion(panSamplesFor(['front', 'top', 'right', 'left'], [400]), cal)!
		const nominal = nominalAxes(point('front', 180), DEFAULT_RIG_DISTORTION, cal)
		const pose = headPose(nominal, cal)
		const off = vec3.length(
			vec3.sub(deltaAt(affineOnly, pose.centre, 0, 0).translation, truePanDelta(pose.centre, 0).translation)
		)
		expect(off).toBeGreaterThan(0.5)
	})

	it('the top point at pans 0 / ±90 separates the pan terms at one radius', () => {
		const ids = ['front', 'top', 'right', 'left']
		const extra = [point('top', 400, {pan: 90}), point('top', 400, {pan: -90})].map(p => {
			const nominal = nominalAxes(p, DEFAULT_RIG_DISTORTION, cal)
			return {nominal, actual: distortedWithPan(nominal), at: 0}
		})
		const field = solveDistortion([...panSamplesFor(ids, [400]), ...extra], cal)!
		expect(field.count).toBe(6)
		expect(field.terms.pan).toBe(true)
		expect(field.residual.linear).toBeLessThan(1e-3)
		const nominal = nominalAxes(point('front', 180), DEFAULT_RIG_DISTORTION, cal)
		const pose = headPose(nominal, cal)
		const got = deltaAt(field, pose.centre, nominal.b, 0)
		expect(nearVec(got.translation, truePanDelta(pose.centre, nominal.b).translation, 5e-3)).toBe(true)
	})

	it('rolled points fit a roll axis off the pupil', () => {
		// The roll axis misses the pupil by e (in the pan frame): rolling swings
		// the camera by Ry(pan)·(Rz(roll) − I)·e.
		const E_ROLL: vec3 = [2, -1.5, 0]
		const trueRollDelta = (p: vec3, panDeg: number, rollDeg: number) => {
			const ry = quat.fromAxisAngle([0, 1, 0], panDeg)
			const rz = quat.fromAxisAngle([0, 0, 1], rollDeg)
			const swing = vec3.transformQuat(vec3.sub(vec3.transformQuat(E_ROLL, rz), E_ROLL), ry)
			const base = truePanDelta(p, panDeg)
			return {translation: vec3.add(base.translation, swing), rotation: base.rotation}
		}
		const sample = (p: DistortionPoint): DistortionSample => {
			const nominal = nominalAxes(p, DEFAULT_RIG_DISTORTION, cal)
			const pose = headPose(nominal, cal)
			const d = trueRollDelta(pose.centre, nominal.b, nominal.c)
			const actual = axesFromHeadPose(
				{centre: vec3.add(pose.centre, d.translation), rotation: quat.mul(rotVecQuat(d.rotation), pose.rotation)},
				cal,
				nominal
			)
			return {nominal, actual, at: 0}
		}
		const pts = distortionPoints({
			radii: [400, 250],
			directions: ['front', 'top', 'right', 'left'],
			topPans: [0, 90],
			rolls: [0, 90, -45],
		})
		const field = solveDistortion(pts.map(sample), cal)!
		expect(field.terms).toEqual({pan: true, roll: true})
		expect(field.residual.linear).toBeLessThan(1e-3)
		// A roll and pan no sample had, closer in.
		const nominal = nominalAxes(point('frontRight', 300, {roll: 30}), DEFAULT_RIG_DISTORTION, cal)
		const pose = headPose(nominal, cal)
		const got = deltaAt(field, pose.centre, nominal.b, nominal.c)
		const want = trueRollDelta(pose.centre, nominal.b, nominal.c)
		expect(nearVec(got.translation, want.translation, 5e-3)).toBe(true)
		// Round trip through the iterative inverse.
		const ideal: RigAxes = {x: 120, y: 350, z: 280, a: -20, b: 35, c: 40}
		const back = workToCalibrated(calibratedToWork(ideal, field, cal), field, cal)
		for (const k of ['x', 'y', 'z', 'a', 'b', 'c'] as const) expect(near(back[k], ideal[k], 2e-3)).toBe(true)
	})

	it('round trip with the pan terms', () => {
		const field = solveDistortion(panSamplesFor(['front', 'top', 'right', 'left'], [400, 250]), cal)!
		const ideal: RigAxes = {x: 120, y: 350, z: 280, a: -20, b: 35, c: 3}
		const work = calibratedToWork(ideal, field, cal)
		const back = workToCalibrated(work, field, cal)
		for (const k of ['x', 'y', 'z', 'a', 'b', 'c'] as const) expect(near(back[k], ideal[k], 2e-3)).toBe(true)
	})

	it('keeps rotaries near their current winding', () => {
		const field = solveDistortion(samplesFor(['front', 'top', 'right', 'left']), cal)!
		const wound: RigAxes = {x: 0, y: 300, z: 300, a: 0, b: 370, c: 0}
		expect(near(calibratedToWork(wound, field, cal).b, 370, 1)).toBe(true)
		expect(near(workToCalibrated(wound, field, cal).b, 370, 1)).toBe(true)
	})

	it('a mount twist is the same world rotation whichever way the head is panned', () => {
		// A twist of the column about world Z shows up as roll (C) with the head
		// looking at the front point, but as tilt (A) once it is panned 90° for
		// the right point. Per-axis deltas would say two different things; the
		// rotation vector says the same.
		const twist = quat.fromAxisAngle([0, 0, 1], 0.5)
		const twisted = (nominal: RigAxes): DistortionSample => {
			const pose = headPose(nominal, cal)
			const actual = axesFromHeadPose({centre: pose.centre, rotation: quat.mul(twist, pose.rotation)}, cal, nominal)
			return {nominal, actual, at: 0}
		}
		const front = twisted(nominalAxes(point('front'), DEFAULT_RIG_DISTORTION, cal))
		const right = twisted(nominalAxes(point('right'), DEFAULT_RIG_DISTORTION, cal))
		expect(near(axisDeltas(front).c, 0.5, 1e-3)).toBe(true)
		expect(near(axisDeltas(front).a, 0, 1e-3)).toBe(true)
		expect(near(Math.abs(axisDeltas(right).a), 0.5, 1e-3)).toBe(true)
		expect(near(axisDeltas(right).c, 0, 1e-3)).toBe(true)
		expect(nearVec(sampleDelta(front, cal).rotation, [0, 0, 0.5])).toBe(true)
		expect(nearVec(sampleDelta(right, cal).rotation, [0, 0, 0.5])).toBe(true)
	})

	it('axisDeltas and completeAxes', () => {
		const s: DistortionSample = {
			nominal: {x: 0, y: 0, z: 0, a: 179, b: 0, c: 0},
			actual: {x: 1.2, y: -0.5, z: 0, a: -179.5, b: 0.25, c: 0},
			at: 0,
		}
		expect(axisDeltas(s)).toEqual({x: 1.2, y: -0.5, z: 0, a: 1.5, b: 0.25, c: 0})
		expect(completeAxes({x: 5}, {x: 1, y: 2, z: 3, a: 4, b: 5, c: 6})).toEqual({x: 5, y: 2, z: 3, a: 4, b: 5, c: 6})
	})

	it('reticle: a 60 mm face at 400 mm through a 170 mm lens on a 35.9 mm sensor', () => {
		// image width of the face = f·s/D = 25.5 mm → 71 % of the sensor.
		expect(near(reticleHalfWidth(60, 400, 170, 35.9) * 2, (170 * 60) / 400 / 35.9, 1e-9)).toBe(true)
		expect(reticleHalfWidth(60, 0, 170, 35.9)).toBe(0)
	})

	it('default calibration works too (no pupil offset)', () => {
		const c0: WorkKinematics = DEFAULT_CALIBRATION
		const n = nominalAxes(point('front'), DEFAULT_RIG_DISTORTION, c0)
		expect(n).toMatchObject({x: 0, y: 120, z: 400})
	})
})
