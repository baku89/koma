import {quat, vec3} from 'linearly'
import {describe, expect, it} from 'vitest'

import type {Project} from '@/stores/project'

import {DEFAULT_CALIBRATION} from './config'
import {millToWorld, rigToWorld, worldToMill, worldToRig} from './coords'
import {
	aimRigAxes,
	anglesToRotation,
	cameraPoseToRigAxes,
	orbitAboutPupil,
	orbitRigAxes,
	rigAxesToCameraPose,
	rotateAboutPupil,
	rotationCentre,
	rotationToAngles,
	workAxesToCameraPose,
} from './kinematics'
import {LED_LAYOUT, LED_PITCH, LED_TOP_Y} from './led/layout'
import {decodeWall, encodeWall, wallRecordPath} from './led/wallRecord'
import {frameDifference, median} from './motion'
import {effectivePlanFor, interpolatedFrames, interpolatePlan, type PlanTable} from './plan'
import {DEFAULT_ADDSUB_DATA, migrateAddsubData, shiftStoredRigAxes} from './projectData'

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps

describe('coords', () => {
	it('mill ↔ world is a cyclic permutation about a shared origin', () => {
		// mill +X → world +Z, +Y → +X, +Z → +Y
		expect(millToWorld([1, 0, 0])).toEqual([0, 0, 1])
		expect(millToWorld([0, 1, 0])).toEqual([1, 0, 0])
		expect(millToWorld([0, 0, 1])).toEqual([0, 1, 0])
		const m: vec3 = [7, 8, 9]
		expect(worldToMill(millToWorld(m))).toEqual(m)
	})

	it('rig ↔ world is the work offset', () => {
		const offset: vec3 = [0, -1300, 0]
		expect(worldToRig([1, 2, 3], offset)).toEqual([1, -1298, 3])
		expect(rigToWorld(worldToRig([1, 2, 3], offset), offset)).toEqual([1, 2, 3])
	})
})

describe('kinematics', () => {
	it('angles → rotation → angles round-trips', () => {
		for (const angles of [
			{tilt: 0, pan: 0, roll: 0},
			{tilt: -30, pan: 45, roll: 5},
			{tilt: 20, pan: -170, roll: -12},
			{tilt: 89, pan: 10, roll: 0},
			{tilt: -100, pan: 100, roll: 30},
		]) {
			const back = rotationToAngles(anglesToRotation(angles))
			expect(near(back.tilt, angles.tilt, 1e-4)).toBe(true)
			expect(near(back.pan, angles.pan, 1e-4)).toBe(true)
			expect(near(back.roll, angles.roll, 1e-4)).toBe(true)
		}
	})

	it('pan is about world Y and tilt about the camera X', () => {
		// Pan 90° turns the −Z view axis toward −X.
		const q = anglesToRotation({tilt: 0, pan: 90, roll: 0})
		const view = vec3.transformQuat([0, 0, -1], q)
		expect(near(view[0], -1)).toBe(true)
		expect(near(view[2], 0)).toBe(true)
		// Tilt −90° looks straight down.
		const down = vec3.transformQuat([0, 0, -1], anglesToRotation({tilt: -90, pan: 0, roll: 0}))
		expect(near(down[1], -1)).toBe(true)
	})

	it('rotation centre sits behind the pupil along the optical axis', () => {
		const pose = {position: [0, 0, 0] as vec3, rotation: quat.identity}
		// Camera looks down −Z; pupil is d in front → centre at +Z·d.
		expect(rotationCentre(pose, [0, 0, -50])).toEqual([0, 0, 50])
		const panned = {position: [0, 0, 0] as vec3, rotation: anglesToRotation({tilt: 0, pan: 90, roll: 0})}
		const c = rotationCentre(panned, [0, 0, -50])
		expect(near(c[0], 50)).toBe(true)
		expect(near(c[2], 0)).toBe(true)
	})

	it('IK → FK round-trips a film-space pose', () => {
		const cal = {
			...DEFAULT_CALIBRATION,
			pupilOffset: [0, 0, -80] as vec3,
			rigOffset: [5, -3, 7] as vec3,
		}
		const pose = {
			position: [300, 400, 500] as vec3,
			rotation: anglesToRotation({tilt: -25, pan: 60, roll: 3}),
		}
		const axes = cameraPoseToRigAxes(pose, cal)
		expect(near(axes.a, -25, 1e-4)).toBe(true)
		expect(near(axes.b, 60, 1e-4)).toBe(true)
		expect(near(axes.c, 3, 1e-4)).toBe(true)
		const back = rigAxesToCameraPose(axes, cal)
		for (let i = 0; i < 3; i++) {
			expect(near(back.position[i], pose.position[i], 1e-6)).toBe(true)
		}
		expect(quat.angle(back.rotation, pose.rotation) < 1e-4).toBe(true)
	})

	it('rotary zeros shift the commanded angles (the work zero of A/B/C)', () => {
		const cal = {
			...DEFAULT_CALIBRATION,
			rotaryZero: {a: 12, b: -90, c: 1.5},
			rotarySigns: {a: -1 as const, b: 1 as const, c: 1 as const},
		}
		const pose = {position: [0, 0, 0] as vec3, rotation: anglesToRotation({tilt: 10, pan: 20, roll: 3})}
		const axes = cameraPoseToRigAxes(pose, cal)
		expect(near(axes.a, 2, 1e-4)).toBe(true)
		expect(near(axes.b, -70, 1e-4)).toBe(true)
		expect(near(axes.c, 4.5, 1e-4)).toBe(true)
		const back = rigAxesToCameraPose(axes, cal)
		expect(quat.angle(back.rotation, pose.rotation) < 1e-4).toBe(true)
	})

	it('rotary signs flip the commanded angles', () => {
		const cal = {...DEFAULT_CALIBRATION, rotarySigns: {a: -1 as const, b: 1 as const, c: -1 as const}}
		const pose = {position: [0, 0, 0] as vec3, rotation: anglesToRotation({tilt: 10, pan: 20, roll: 30})}
		const axes = cameraPoseToRigAxes(pose, cal)
		expect(near(axes.a, -10, 1e-4)).toBe(true)
		expect(near(axes.b, 20, 1e-4)).toBe(true)
		expect(near(axes.c, -30, 1e-4)).toBe(true)
		const back = rigAxesToCameraPose(axes, cal)
		expect(quat.angle(back.rotation, pose.rotation) < 1e-4).toBe(true)
	})
})

describe('aim', () => {
	const cal = {
		...DEFAULT_CALIBRATION,
		pupilOffset: [0, 0, -80] as vec3,
		rigOffset: [-100, -500, 0] as vec3,
		rotaryZero: {a: 5, b: -90, c: 2},
		rotarySigns: {a: -1 as const, b: 1 as const, c: 1 as const},
	}

	/** Angle (deg) between the optical axis and the line pupil → target. */
	function miss(axes: {x: number; y: number; z: number; a: number; b: number; c: number}, target: vec3) {
		const pose = rigAxesToCameraPose(axes, cal) // film = world here
		const forward = vec3.transformQuat([0, 0, -1], pose.rotation)
		const to = vec3.normalize(vec3.sub(target, pose.position))
		return (Math.acos(Math.min(1, vec3.dot(forward, to))) * 180) / Math.PI
	}

	it('puts the work point on the optical axis, roll untouched', () => {
		for (const c of [2, 14, -28]) {
			const axes = {x: 150, y: -180, z: 320, a: 40, b: 200, c}
			for (const target of [[0, 0, 0], [30, 60, -20], [-200, 10, 400]] as vec3[]) {
				const aim = aimRigAxes(axes, target, cal)!
				expect(Object.keys(aim).sort()).toEqual(['a', 'b'])
				// acos near 1 only resolves ~1e-6°.
				expect(miss({...axes, ...aim}, target)).toBeLessThan(1e-4)
			}
		}
	})

	it('turns pan the shorter way from where it is', () => {
		const target: vec3 = [0, 0, 0]
		const near = aimRigAxes({x: 150, y: -180, z: 320, a: 0, b: 0, c: 2}, target, cal)!
		const far = aimRigAxes({x: 150, y: -180, z: 320, a: 0, b: 720, c: 2}, target, cal)!
		expect(Math.abs(near.b)).toBeLessThanOrEqual(180)
		expect(far.b - near.b).toBeCloseTo(720)
	})

	it('keeps pan for a point straight below, gives up at the centre itself', () => {
		const axes = {x: -100, y: -200, z: 0, a: 0, b: 33, c: 2} // centre at world (0, 300, 0), no roll
		const aim = aimRigAxes(axes, [0, 0, 0], cal)!
		expect(aim.b).toBeCloseTo(33)
		expect(aim.a).toBeCloseTo(-1 * -90 + 5)
		expect(aimRigAxes(axes, [0, 300, 0], cal)).toBeNull()
	})
})

describe('rotate about the pupil', () => {
	const cal = {
		...DEFAULT_CALIBRATION,
		pupilOffset: [4, -2, -80] as vec3,
		rigOffset: [-100, -500, 0] as vec3,
		rotaryZero: {a: 5, b: -90, c: 2},
		rotarySigns: {a: -1 as const, b: 1 as const, c: 1 as const},
	}
	const axes = {x: 20, y: -400, z: 300, a: 15, b: -60, c: 3}

	it('keeps the pupil where it is and turns the camera by the delta', () => {
		const before = rigAxesToCameraPose(axes, cal)
		for (const delta of [{pan: 10}, {tilt: -7}, {roll: 20}, {pan: 5, tilt: 5, roll: -5}]) {
			const target = rotateAboutPupil(axes, delta, cal)
			const after = rigAxesToCameraPose(target, cal)
			for (let i = 0; i < 3; i++) {
				expect(near(after.position[i], before.position[i], 1e-6)).toBe(true)
			}
			// (quat.angle is NaN when the dot rounds just past 1, so compare dots.)
			expect(Math.abs(quat.dot(after.rotation, orbitAboutPupil(before, delta).rotation))).toBeCloseTo(1, 8)
		}
	})

	it('pan is about world Y: a tilted camera stays level', () => {
		const target = rotateAboutPupil(axes, {pan: 30}, cal)
		expect(near(target.a, axes.a, 1e-6)).toBe(true)
		expect(near(target.c, axes.c, 1e-6)).toBe(true)
		expect(near(target.b, axes.b + 30, 1e-6)).toBe(true)
	})

	it('moves the head only as far as the offset makes it', () => {
		// With no offset the head centre is the pupil: X/Y/Z stay.
		const noOffset = {...cal, pupilOffset: [0, 0, 0] as vec3}
		const target = rotateAboutPupil(axes, {pan: 30, tilt: 10}, noOffset)
		expect(near(target.x, axes.x, 1e-6)).toBe(true)
		expect(near(target.y, axes.y, 1e-6)).toBe(true)
		expect(near(target.z, axes.z, 1e-6)).toBe(true)
	})

	it('takes the rotaries the short way round', () => {
		const target = rotateAboutPupil({...axes, b: 350}, {pan: 20}, cal)
		expect(near(target.b, 370, 1e-6)).toBe(true)
	})
})

describe('orbit', () => {
	it('rotates the whole camera pose about the vertical axis at X = Z = 0', () => {
		const cal = {
			...DEFAULT_CALIBRATION,
			pupilOffset: [0, 0, -80] as vec3,
			rigOffset: [30, -1300, -20] as vec3,
			rotarySigns: {a: 1, b: -1, c: 1} as const,
		}
		const axes = {x: 300, y: -400, z: 450, a: -20, b: 35, c: 4}
		const before = rigAxesToCameraPose(axes, cal)
		const after = rigAxesToCameraPose({...axes, ...orbitRigAxes(axes, 25, cal)}, cal)

		const turn = quat.fromAxisAngle([0, 1, 0], 25)
		const expected = vec3.transformQuat(before.position, turn)
		expect(vec3.distance(after.position, expected)).toBeLessThan(1e-6)
		const q = quat.mul(turn, before.rotation)
		expect(Math.abs(quat.dot(after.rotation, q))).toBeCloseTo(1, 9)
		// Height, tilt and roll are untouched.
		expect(after.position[1]).toBeCloseTo(before.position[1], 9)
	})
})

describe('led layout', () => {
	// Spot values read from the Houdini set model (/obj/LED_box, metres → mm),
	// which the hard-coded layout was checked against pixel for pixel.
	const layout = LED_LAYOUT
	const line = (i: number) => layout.pixels.filter(p => p.line === i)

	it('has nine strips on L/B/R lines and ten on F1/F2, 42 pixels each', () => {
		expect(layout.lineCounts).toEqual([378, 378, 378, 378, 378, 378, 420, 420])
		expect(layout.pixels.length).toBe(3108)
		expect(layout.pitch).toBeCloseTo(33.4146, 3)
		expect(layout.version).toBe(2)
	})

	it('snakes vertically from the top: strip 0 top→bottom, strip 1 bottom→top', () => {
		const l1 = line(0)
		expect(l1[0].world).toEqual([-900, LED_TOP_Y, 850])
		expect(l1[41].world[1]).toBeCloseTo(-105, 6)
		expect(l1[42].world).toEqual([-900, l1[41].world[1], 750])
		expect(l1[83].world[1]).toBe(LED_TOP_Y)
		expect(l1[0].world[1] - l1[1].world[1]).toBeCloseTo(LED_PITCH, 9)
	})

	it('walks round the inside: L (x −900) → B (z −900) → R (x +900) → F (z +1000)', () => {
		expect(line(1)[0].world).toEqual([-900, LED_TOP_Y, -50])
		expect(line(1).at(-1)!.world[2]).toBe(-850)
		expect(line(2)[0].world).toEqual([-50, LED_TOP_Y, -900])
		expect(line(3)[0].world).toEqual([850, LED_TOP_Y, -900])
		expect(line(4)[0].world).toEqual([900, LED_TOP_Y, -50])
		expect(line(5)[0].world).toEqual([900, LED_TOP_Y, 50])
		expect(line(5).at(-1)!.world[2]).toBe(850)
		expect(line(2)[0].face).toBe('B')
		expect(line(7)[0].face).toBe('F')
	})

	it("F's first and last strips stand round the corner on the R and L walls", () => {
		const f1 = line(6)
		const f2 = line(7)
		expect(f1[0].world).toEqual([900, LED_TOP_Y, 950])
		expect(f1[42].world[1]).toBeCloseTo(-105, 6)
		expect(f1[42].world[0]).toBe(850)
		expect(f1[42].world[2]).toBe(1000)
		expect(f2[0].world).toEqual([-50, LED_TOP_Y, 1000])
		// Tenth strip of F2: index 9 (odd) runs bottom→top.
		expect(f2[9 * 42].world[0]).toBe(-900)
		expect(f2[9 * 42].world[2]).toBe(950)
		expect(f2[9 * 42].world[1]).toBeCloseTo(-105, 6)
		expect(f2.at(-1)!.world[1]).toBe(LED_TOP_Y)
	})
})

describe('plan interpolation', () => {
	// A Project stub with just what plan.ts reads.
	function stubProject(plan: PlanTable) {
		return {layers: [{id: 'main', name: 'Main'}], addsub: {plan}} as unknown as Project
	}

	it('interpolates rig axes linearly between planned frames and holds lone axes', () => {
		const project = stubProject({
			main: {
				2: {rig: {x: 0, y: -100, z: 50}, cameraConfigs: {aperture: 8}},
				6: {rig: {x: 40, y: -100}, cameraConfigs: {aperture: 11}},
			},
		})
		expect(effectivePlanFor(project, 2, 0)).toMatchObject({kind: 'explicit'})
		const mid = effectivePlanFor(project, 4, 0)
		expect(mid).toMatchObject({kind: 'interpolated', from: 2, to: 6})
		expect(mid!.plan.rig).toEqual({x: 20, y: -100, z: 50})
		// Exposure steps: the earlier key's configs are held.
		expect(mid!.plan.cameraConfigs).toEqual({aperture: 8})
		expect(effectivePlanFor(project, 5, 0)!.plan.rig!.x).toBeCloseTo(30)
		// Outside the planned range there is no plan.
		expect(effectivePlanFor(project, 1, 0)).toBeNull()
		expect(effectivePlanFor(project, 7, 0)).toBeNull()
		expect(interpolatedFrames(project, 0)).toEqual([3, 4, 5])
		// Another layer has nothing.
		expect(effectivePlanFor(project, 4, 1)).toBeNull()
	})

	it('glides the pupil in a straight line between six-axis keys', () => {
		const cal = {pupilOffset: [0, 0, -80] as vec3, rotarySigns: {a: 1 as const, b: 1 as const, c: 1 as const}}
		const a = {rig: {x: 0, y: 0, z: 0, a: 0, b: 0, c: 0}}
		const b = {rig: {x: 0, y: 0, z: 0, a: 0, b: 90, c: 0}}
		// Same head centre, a quarter turn: the pupil goes from (0,0,−80) to
		// (−80,0,0); half way the pupil is on the chord, not where the head is.
		const mid = interpolatePlan(a, b, 0.5, cal).rig!
		expect(mid.b).toBeCloseTo(45)
		const pupil = workAxesToCameraPose(mid, cal).position
		expect(pupil[0]).toBeCloseTo(-40)
		expect(pupil[2]).toBeCloseTo(-40)
		expect(mid.x).not.toBeCloseTo(0)
		// Without the calibration (or with no offset) the axes are plain lerps.
		expect(interpolatePlan(a, b, 0.5).rig).toEqual({x: 0, y: 0, z: 0, a: 0, b: 45, c: 0})
		const flat = interpolatePlan(a, b, 0.5, {...cal, pupilOffset: [0, 0, 0]}).rig
		expect(flat).toEqual({x: 0, y: 0, z: 0, a: 0, b: 45, c: 0})
		// A key missing an axis falls back to per-axis.
		expect(interpolatePlan({rig: {x: 0, b: 0}}, {rig: {x: 10, b: 90}}, 0.5, cal).rig).toEqual({x: 5, b: 45})
	})

	it('interpolates camera poses (lerp + slerp) when both keys are poses', () => {
		const a = {position: [0, 0, 0] as vec3, rotation: quat.identity}
		const b = {position: [100, 0, 0] as vec3, rotation: quat.fromAxisAngle([0, 1, 0], Math.PI / 2)}
		const project = stubProject({main: {0: {camera: a}, 10: {camera: b}}})
		const half = effectivePlanFor(project, 5, 0)!.plan.camera!
		expect(half.position[0]).toBeCloseTo(50)
		expect(quat.angle(half.rotation, quat.fromAxisAngle([0, 1, 0], Math.PI / 4))).toBeCloseTo(0, 5)
	})
})

describe('led wall record', () => {
	const lines = [new Uint8Array([1, 2, 3, 4, 5, 6]), new Uint8Array(0), new Uint8Array([255, 0, 128])]

	it('round-trips every line', () => {
		expect(decodeWall(encodeWall(lines))).toEqual(lines)
	})

	it('names a record by its content', async () => {
		const a = await wallRecordPath(encodeWall(lines))
		expect(a).toMatch(/^led-wall\/[0-9a-f]{16}\.ledwall$/)
		expect(await wallRecordPath(encodeWall(lines.map(l => l.slice())))).toBe(a)
		expect(await wallRecordPath(encodeWall([lines[0]]))).not.toBe(a)
	})

	it('rejects files that are not records', () => {
		expect(() => decodeWall(new Uint8Array([1, 2, 3, 4, 5]))).toThrow()
		expect(() => decodeWall(encodeWall(lines).subarray(0, 12))).toThrow('truncated')
	})
})

describe('live view motion', () => {
	it('is the mean absolute difference of two frames', () => {
		expect(frameDifference(new Uint8Array([10, 20, 30, 40]), new Uint8Array([10, 22, 26, 40]))).toBe(1.5)
		expect(frameDifference(new Uint8Array(4), new Uint8Array(4))).toBe(0)
	})

	it('takes the median as the level at rest', () => {
		expect(median([3, 1, 2])).toBe(2)
		expect(median([4, 1, 9, 2])).toBe(3)
	})
})

describe('stored rig axes', () => {
	const legacy = () => ({
		addsub: {
			...structuredClone(DEFAULT_ADDSUB_DATA),
			calibration: {
				...structuredClone(DEFAULT_CALIBRATION),
				rigOffset: [-100, -500, 0] as vec3,
				rotaryZero: {a: 0, b: 90, c: 0},
			},
			plan: {main: {3: {rig: {x: -90, y: -550.5}}, 4: {cameraConfigs: {iso: 100}}}},
			parkPose: {x: 0, y: -100, z: 0, a: 0, b: 90, c: 0},
		},
		komas: [
			{shots: [{rig: {x: -123.456, y: -550.5, z: 320, a: -86.019, b: 12.5, c: 0}}, null]},
			{shots: [null], backupShots: [{rig: {x: 1, y: 2, z: 3}}]},
			null,
		],
		trash: [{shot: {rig: {x: -100, y: -500, z: 0}}}],
	})

	it('turns a scalar pupil distance into the camera-space offset', () => {
		const project = {
			addsub: {calibration: {...DEFAULT_CALIBRATION, pupilOffset: 80 as unknown as vec3}, plan: {}, rigLimits: {}},
			komas: [],
		} as any
		migrateAddsubData(project)
		expect(project.addsub.calibration.pupilOffset).toEqual([0, 0, -80])
		migrateAddsubData(project)
		expect(project.addsub.calibration.pupilOffset).toEqual([0, 0, -80])
	})

	it('drops the retired block / shoot-position / G54 settings and shot lifts', () => {
		const project = {
			addsub: {
				...DEFAULT_ADDSUB_DATA,
				plan: {},
				calibration: {...DEFAULT_CALIBRATION, filmOriginWorld: [0, 12, 0], millOffset: [1, 2, 3]},
				kBase: 1,
				filmLift: 60,
				blockHeight: 60,
				shootPosition: {x: 200},
				millFeed: 1000,
				ledOptional: true,
				cutSetsWorkOffset: true,
			},
			komas: [{shots: [{rig: {x: 1}, filmLift: 60, kBase: 1}]}],
			trash: [{shot: {rig: {x: 2}, filmLift: 0}}],
		} as any
		migrateAddsubData(project)
		for (const key of ['kBase', 'filmLift', 'blockHeight', 'shootPosition', 'millFeed', 'ledOptional', 'cutSetsWorkOffset']) {
			expect(key in project.addsub).toBe(false)
		}
		expect('filmOriginWorld' in project.addsub.calibration).toBe(false)
		expect('millOffset' in project.addsub.calibration).toBe(false)
		expect(project.komas[0].shots[0]).toEqual({rig: {x: 1}})
		expect(project.trash[0].shot).toEqual({rig: {x: 2}})
	})

	it('a file in machine coordinates is converted to work coordinates once', () => {
		const p = legacy()
		migrateAddsubData(p, {rigInMachine: true})
		expect(p.addsub.rigStorage).toBe('work')
		expect(p.addsub.rigRebase).toBe(true)
		expect(p.addsub.plan.main[3].rig).toEqual({x: 10, y: -50.5})
		expect(p.komas[0]!.shots[0]!.rig).toEqual({x: -23.456, y: -50.5, z: 320, a: -86.019, b: -77.5, c: 0})
		expect(p.komas[1]!.backupShots![0].rig).toEqual({x: 101, y: 502, z: 3})
		expect(p.trash[0].shot.rig).toEqual({x: 0, y: 0, z: 0})
		expect(p.addsub.parkPose).toEqual({x: 100, y: 400, z: 0, a: 0, b: 0, c: 0})
		// Already in work coordinates: left alone.
		migrateAddsubData(p)
		expect(p.addsub.plan.main[3].rig).toEqual({x: 10, y: -50.5})
	})

	it('re-basing keeps machine = work + offset when the offset changes', () => {
		const p = legacy()
		migrateAddsubData(p, {rigInMachine: true})
		// The controller says the work origin is at machine Y −480, not −500.
		shiftStoredRigAxes(p, {y: -500 - -480})
		expect(p.addsub.plan.main[3].rig).toEqual({x: 10, y: -70.5})
		expect(p.addsub.plan.main[3].rig.y + -480).toBeCloseTo(-550.5)
	})
})

