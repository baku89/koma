import {quat, vec3} from 'linearly'
import {describe, expect, it} from 'vitest'

import {DEFAULT_CALIBRATION, DEFAULT_LED_LAYOUT} from './config'
import {
	filmOriginMill,
	filmToWorld,
	millToWorld,
	tableShiftWorld,
	worldToFilm,
	worldToMill,
} from './coords'
import {
	anglesToRotation,
	cameraPoseToRigAxes,
	rigAxesToCameraPose,
	rotationCentre,
	rotationToAngles,
} from './kinematics'
import {buildLedLayout, faceToWorld} from './led/layout'
import {sampleLedFrame} from './led/sampler'

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps

describe('coords', () => {
	it('film ↔ world lifts by 60·kBase', () => {
		const origin: vec3 = [10, 5, -20]
		const w = filmToWorld([1, 2, 3], 2, origin)
		expect(w).toEqual([11, 127, -17])
		expect(worldToFilm(w, 2, origin)).toEqual([1, 2, 3])
	})

	it('mill ↔ world is a cyclic permutation plus offset', () => {
		const t: vec3 = [100, 200, 300]
		// mill +X → world +Z, +Y → +X, +Z → +Y
		expect(millToWorld([1, 0, 0], t)).toEqual([100, 200, 301])
		expect(millToWorld([0, 1, 0], t)).toEqual([101, 200, 300])
		expect(millToWorld([0, 0, 1], t)).toEqual([100, 201, 300])
		const m: vec3 = [7, 8, 9]
		expect(worldToMill(millToWorld(m, t), t)).toEqual(m)
	})

	it('table shift moves the block opposite to the table travel', () => {
		expect(tableShiftWorld({x: 250, y: 0}, {x: 200})).toEqual([-0, 0, -50])
		expect(tableShiftWorld({x: 200, y: 30}, {x: 200, y: 10})).toEqual([-20, 0, -0])
	})

	it('G54 origin rises one block per appended block', () => {
		const a = filmOriginMill(0, [0, 12, 0], [0, 0, 0])
		const b = filmOriginMill(1, [0, 12, 0], [0, 0, 0])
		expect(a).toEqual([0, 0, 12])
		expect(b).toEqual([0, 0, 72])
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
		expect(rotationCentre(pose, 50)).toEqual([0, 0, 50])
		const panned = {position: [0, 0, 0] as vec3, rotation: anglesToRotation({tilt: 0, pan: 90, roll: 0})}
		const c = rotationCentre(panned, 50)
		expect(near(c[0], 50)).toBe(true)
		expect(near(c[2], 0)).toBe(true)
	})

	it('IK → FK round-trips a film-space pose', () => {
		const cal = {
			...DEFAULT_CALIBRATION,
			pupilOffset: 80,
			filmOriginWorld: [100, 20, -50] as vec3,
			rigOffset: [5, -3, 7] as vec3,
		}
		const pose = {
			position: [300, 400, 500] as vec3,
			rotation: anglesToRotation({tilt: -25, pan: 60, roll: 3}),
		}
		const axes = cameraPoseToRigAxes(pose, 2, cal)
		expect(near(axes.a, -25, 1e-4)).toBe(true)
		expect(near(axes.b, 60, 1e-4)).toBe(true)
		expect(near(axes.c, 3, 1e-4)).toBe(true)
		const back = rigAxesToCameraPose(axes, 2, cal)
		for (let i = 0; i < 3; i++) {
			expect(near(back.position[i], pose.position[i], 1e-6)).toBe(true)
		}
		expect(quat.angle(back.rotation, pose.rotation) < 1e-4).toBe(true)
	})

	it('rotary signs flip the commanded angles', () => {
		const cal = {...DEFAULT_CALIBRATION, rotarySigns: {a: -1 as const, b: 1 as const, c: -1 as const}}
		const pose = {position: [0, 0, 0] as vec3, rotation: anglesToRotation({tilt: 10, pan: 20, roll: 30})}
		const axes = cameraPoseToRigAxes(pose, 0, cal)
		expect(near(axes.a, -10, 1e-4)).toBe(true)
		expect(near(axes.b, 20, 1e-4)).toBe(true)
		expect(near(axes.c, -30, 1e-4)).toBe(true)
		const back = rigAxesToCameraPose(axes, 0, cal)
		expect(quat.angle(back.rotation, pose.rotation) < 1e-4).toBe(true)
	})
})

describe('led layout', () => {
	const layout = buildLedLayout(DEFAULT_LED_LAYOUT)

	it('has 8 lines of stripsPerLine × pixelsPerStrip', () => {
		expect(layout.lineCounts).toEqual(Array(8).fill(420))
		expect(layout.pixels.length).toBe(3360)
		expect(near(layout.pitch, 1400 / 42)).toBe(true)
	})

	it('snakes: strip 0 runs left→right, strip 1 right→left', () => {
		const line0 = layout.pixels.filter(p => p.line === 0)
		expect(line0[0].u < line0[41].u).toBe(true)
		expect(line0[42].u > line0[83].u).toBe(true)
		expect(near(line0[0].u, 50 + layout.pitch / 2)).toBe(true)
		expect(line0[0].y).toBe(DEFAULT_LED_LAYOUT.topY)
		expect(line0[42].y).toBe(DEFAULT_LED_LAYOUT.topY - 100)
	})

	it('line 1 continues below line 0 on the same face', () => {
		const line1 = layout.pixels.filter(p => p.line === 1)
		expect(line1[0].face).toBe('L')
		expect(line1[0].y).toBe(DEFAULT_LED_LAYOUT.topY - 10 * 100)
	})

	it('walks around the inside: L→B→R→F share edges', () => {
		const w = 1500
		// Right edge of L meets left edge of B at (−h, y, −h).
		expect(faceToWorld('L', w, 0, w)).toEqual([-750, 0, -750])
		expect(faceToWorld('B', 0, 0, w)).toEqual([-750, 0, -750])
		expect(faceToWorld('B', w, 0, w)).toEqual([750, 0, -750])
		expect(faceToWorld('R', 0, 0, w)).toEqual([750, 0, -750])
		expect(faceToWorld('R', w, 0, w)).toEqual([750, 0, 750])
		expect(faceToWorld('F', 0, 0, w)).toEqual([750, 0, 750])
		expect(faceToWorld('F', w, 0, w)).toEqual([-750, 0, 750])
		expect(faceToWorld('L', 0, 0, w)).toEqual([-750, 0, 750])
	})
})

describe('led sampler', () => {
	const layout = buildLedLayout(DEFAULT_LED_LAYOUT)

	function solidImage(width: number, height: number, faceColors: [number, number, number][]) {
		const data = new Uint8ClampedArray(width * height * 4)
		const faceW = width / 4
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const [r, g, b] = faceColors[Math.min(3, Math.floor(x / faceW))]
				const i = (y * width + x) * 4
				data[i] = r
				data[i + 1] = g
				data[i + 2] = b
				data[i + 3] = 255
			}
		}
		return {width, height, data}
	}

	it('maps each face to its two lines', () => {
		// 0.2 px/mm: 4 faces × 1500 mm = 1200 px wide; tall enough for the wall.
		const img = solidImage(1200, 600, [
			[255, 0, 0],
			[0, 255, 0],
			[0, 0, 255],
			[255, 255, 255],
		])
		const lines = sampleLedFrame(layout, img, {topFilmY: 1500, lift: 0})
		expect(lines.length).toBe(8)
		expect([...lines[0].slice(0, 3)]).toEqual([255, 0, 0])
		expect([...lines[1].slice(0, 3)]).toEqual([255, 0, 0])
		expect([...lines[2].slice(0, 3)]).toEqual([0, 255, 0])
		expect([...lines[5].slice(0, 3)]).toEqual([0, 0, 255])
		expect([...lines[7].slice(-3)]).toEqual([255, 255, 255])
	})

	it('shifts the sampled band by the lift', () => {
		// Image: top half black, bottom half white, boundary at film Y = 1000.
		const width = 1200
		const height = 400 // 2000 mm tall at 0.2 px/mm → film Y 1500 … −500
		const data = new Uint8ClampedArray(width * height * 4)
		for (let y = 0; y < height; y++) {
			const v = y < 100 ? 0 : 255 // 100 px = 500 mm → boundary at film Y 1000
			for (let x = 0; x < width; x++) {
				const i = (y * width + x) * 4
				data[i] = data[i + 1] = data[i + 2] = v
				data[i + 3] = 255
			}
		}
		const img = {width, height, data}
		// Strip row 4 is at world Y 1100 → film 1100 (lift 0): black.
		const a = sampleLedFrame(layout, img, {topFilmY: 1500, lift: 0, boxSize: 0})
		const row4 = layout.pixels.find(p => p.line === 0 && p.y === 1100)!
		expect(a[0][row4.index * 3]).toBe(0)
		// With a lift of 120 (kBase 2) the same LED reads film Y 980: white.
		const b = sampleLedFrame(layout, img, {topFilmY: 1500, lift: 120, boxSize: 0})
		expect(b[0][row4.index * 3]).toBe(255)
	})
})
