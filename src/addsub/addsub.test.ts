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
import {buildLedLayout, faceToWorld, ledLayoutFromSet} from './led/layout'
import {sampleLedFrame} from './led/sampler'

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps

describe('coords', () => {
	it('film ↔ world lifts by filmLift (mm)', () => {
		const origin: vec3 = [10, 5, -20]
		const w = filmToWorld([1, 2, 3], 120, origin)
		expect(w).toEqual([11, 127, -17])
		expect(worldToFilm(w, 120, origin)).toEqual([1, 2, 3])
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

	it('G54 origin rises by the film lift', () => {
		const a = filmOriginMill(0, [0, 12, 0], [0, 0, 0])
		const b = filmOriginMill(60, [0, 12, 0], [0, 0, 0])
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

	it('stands vertical strips 100 mm apart: 20 on L/R (1991), 18 on B/F (1831)', () => {
		// L/R: 19 strips fit in 1991 at 100 mm → floor(19.91) = 19? No: strips at
		// 0…1900 → 20 positions need 1900 mm; floor(1991/100) = 19 → 19 strips.
		expect(layout.lineCounts).toEqual([420, 378, 420, 336, 420, 378, 420, 336])
		expect(near(layout.pitch, 1400 / 42)).toBe(true)
		expect(layout.imageWidth).toBe(2 * 1831 + 2 * 1991)
	})

	it('snakes vertically: strip 0 runs top→bottom, strip 1 bottom→top', () => {
		const line0 = layout.pixels.filter(p => p.line === 0)
		expect(line0[0].y).toBeGreaterThan(line0[41].y)
		expect(line0[42].y).toBeLessThan(line0[83].y)
		expect(near(line0[0].y, 1400 - layout.pitch / 2)).toBe(true)
		expect(near(line0[42].u - line0[0].u, 100)).toBe(true)
	})

	it('second line continues along the same face', () => {
		const line1 = layout.pixels.filter(p => p.line === 1)
		expect(line1[0].face).toBe('L')
		expect(line1[0].u).toBeGreaterThan(layout.pixels.filter(p => p.line === 0).at(-1)!.u)
	})

	it('walks around the inside: L→B→R→F share edges', () => {
		const p = {sizeX: 1831, sizeZ: 1991}
		expect(faceToWorld('L', 1991, 0, p)).toEqual([-915.5, 0, -995.5])
		expect(faceToWorld('B', 0, 0, p)).toEqual([-915.5, 0, -995.5])
		expect(faceToWorld('B', 1831, 0, p)).toEqual([915.5, 0, -995.5])
		expect(faceToWorld('R', 0, 0, p)).toEqual([915.5, 0, -995.5])
		expect(faceToWorld('R', 1991, 0, p)).toEqual([915.5, 0, 995.5])
		expect(faceToWorld('F', 0, 0, p)).toEqual([915.5, 0, 995.5])
		expect(faceToWorld('F', 1831, 0, p)).toEqual([-915.5, 0, 995.5])
		expect(faceToWorld('L', 0, 0, p)).toEqual([-915.5, 0, 995.5])
	})
})

describe('led sampler', () => {
	const layout = buildLedLayout(DEFAULT_LED_LAYOUT)

	function solidImage(width: number, height: number, faceColors: [number, number, number][]) {
		const data = new Uint8ClampedArray(width * height * 4)
		const scale = width / layout.imageWidth
		const edges = [1991, 1991 + 1831, 1991 + 1831 + 1991].map(e => e * scale)
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const face = edges.findIndex(e => x < e)
				const [r, g, b] = faceColors[face === -1 ? 3 : face]
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
		// 0.2 px/mm: (1831 + 1991) × 2 = 7644 mm → 1529 px wide.
		const img = solidImage(1529, 600, [
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
		// Image: top part black, rest white, boundary at film Y = 1000.
		const width = 1529
		const height = 400 // 2000 mm tall at 0.2 px/mm → film Y 1400 … −600
		const data = new Uint8ClampedArray(width * height * 4)
		for (let y = 0; y < height; y++) {
			const v = y < 80 ? 0 : 255 // 80 px = 400 mm → boundary at film Y 1000
			for (let x = 0; x < width; x++) {
				const i = (y * width + x) * 4
				data[i] = data[i + 1] = data[i + 2] = v
				data[i + 3] = 255
			}
		}
		const img = {width, height, data}
		// A pixel at world Y ≈ 1050 reads film 1050 (lift 0): black.
		const px = layout.pixels.find(p => p.line === 0 && Math.abs(p.y - 1050) < layout.pitch / 2)!
		const a = sampleLedFrame(layout, img, {topFilmY: 1400, lift: 0, boxSize: 0})
		expect(a[0][px.index * 3]).toBe(0)
		// With a lift of 120 (two 60 mm blocks added) the same LED reads film Y ≈ 930: white.
		const b = sampleLedFrame(layout, img, {topFilmY: 1400, lift: 120, boxSize: 0})
		expect(b[0][px.index * 3]).toBe(255)
	})
})

describe('led layout from set.json', () => {
	const set = {
		layoutVersion: 3,
		frame: 'rig' as const,
		unit: 'm' as const,
		imageWidth: 7.644,
		pitch: 0.0333,
		lines: [
			{name: 'L1', pixels: [[-0.95, 0.3936, 0.9, 0.0955] as [number, number, number, number]]},
			{name: 'L2', pixels: []},
		],
	}
	const rigOffset: vec3 = [-600, -1300, -600]

	it('converts rig metres to world millimetres with the rig offset', () => {
		const layout = ledLayoutFromSet(set, {rigOffset})
		expect(layout.source).toBe('set')
		expect(layout.version).toBe(3)
		expect(layout.lineCounts).toEqual([1, 0])
		expect(layout.imageWidth).toBeCloseTo(7644)
		expect(layout.pitch).toBeCloseTo(33.3)
		const px = layout.pixels[0]
		// world = rig − rigOffset
		expect(px.world[0]).toBeCloseTo(-950 + 600)
		expect(px.world[1]).toBeCloseTo(393.6 + 1300)
		expect(px.world[2]).toBeCloseTo(900 + 600)
		expect(px.y).toBeCloseTo(px.world[1])
		expect(px.u).toBeCloseTo(95.5)
	})

	it('leaves world millimetres alone by default', () => {
		const layout = ledLayoutFromSet({
			imageWidth: 7644,
			lines: [{pixels: [[10, 20, 30, 40]]}],
		})
		expect(layout.pixels[0].world).toEqual([10, 20, 30])
		expect(layout.pixels[0].u).toBe(40)
		expect(layout.version).toBe(1)
	})
})
