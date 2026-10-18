import {describe, expect, it} from 'vitest'

import {
	DEFAULT_LENS_CALIBRATION,
	distanceAlongAxis,
	fitLensTable,
	focusForDistance,
	lensAtFocus,
	type LensCalibration,
	lensCalibrationJson,
	parseLensSheet,
} from './lens'

/** A fake lens: pupil 90 mm in front of the centre, focal rising with focus. */
function halfWidth(distanceFromCentre: number, focal: number, pupil = 90) {
	return (17.95 * (distanceFromCentre - pupil)) / focal
}

describe('lens sheet parsing', () => {
	it('reads 3-column rows (the sheet as typed) and skips the header', () => {
		const text = `撮影距離\tNormalized Focus Distance\t映り込み (mm)
270\t0\t15.5
290\t0.13\t20
`
		expect(parseLensSheet(text, 100)).toEqual([
			{focus: 0, distance: 270, halfWidth: 15.5, inFocus: true},
			{focus: 0.13, distance: 290, halfWidth: 20, inFocus: true},
		])
	})

	it('turns a 4th column into a second, unfocused target farStep farther', () => {
		expect(parseLensSheet('270\t0\t15.5\t21.2', 100)).toEqual([
			{focus: 0, distance: 270, halfWidth: 15.5, inFocus: true},
			{focus: 0, distance: 370, halfWidth: 21.2, inFocus: false},
		])
	})

	it('takes an explicit far distance from a 5-column row, and commas', () => {
		expect(parseLensSheet('270, 0, 15.5, 420, 24', 100)).toEqual([
			{focus: 0, distance: 270, halfWidth: 15.5, inFocus: true},
			{focus: 0, distance: 420, halfWidth: 24, inFocus: false},
		])
	})
})

describe('lens table fit', () => {
	const cal: LensCalibration = {
		...DEFAULT_LENS_CALIBRATION,
		originIsPupil: false,
		originOffset: 40, // distances measured from 40 mm in front of the centre
		samples: [],
	}

	it('with distances from the pupil, one target gives the focal; the pupil is the calibration\'s', () => {
		// Pupil 90 mm in front of the centre; the sheet measures from the pupil.
		const rows = [
			{focus: 0.2, distance: 320 - 90, halfWidth: halfWidth(320, 150), inFocus: true},
			{focus: 0.6, distance: 500 - 90, halfWidth: halfWidth(500, 130), inFocus: true},
		]
		const table = fitLensTable({...DEFAULT_LENS_CALIBRATION, samples: rows}, 90)
		expect(table.map(r => r.pupilSource)).toEqual(['pupil', 'pupil'])
		expect(table[0].focal).toBeCloseTo(150, 6)
		expect(table[0].distance).toBeCloseTo(320, 6)
		expect(table[0].pupil).toBe(90)
		expect(table[1].focal).toBeCloseTo(130, 6)
	})

	it('recovers focal and pupil from two targets at one setting', () => {
		// Setting 0.2 focuses 320 mm from the centre with a 150 mm pinhole focal.
		const rows = [
			{focus: 0.2, distance: 320 - 40, halfWidth: halfWidth(320, 150), inFocus: true},
			{focus: 0.2, distance: 420 - 40, halfWidth: halfWidth(420, 150), inFocus: false},
		]
		const [row] = fitLensTable({...cal, samples: rows})
		expect(row.focus).toBe(0.2)
		expect(row.distance).toBeCloseTo(320, 6)
		expect(row.focal).toBeCloseTo(150, 6)
		expect(row.pupil).toBeCloseTo(90, 6)
		expect(row.pupilSource).toBe('fitted')
	})

	it('falls back to an assumed pupil with a single target', () => {
		const rows = [{focus: 0.2, distance: 280, halfWidth: halfWidth(320, 150), inFocus: true}]
		const [row] = fitLensTable({...cal, samples: rows}, 90)
		expect(row.focal).toBeCloseTo(150, 6)
		expect(row.pupil).toBe(90)
		expect(row.pupilSource).toBe('assumed')
		// A wrong assumption shifts the focal in proportion.
		const [wrong] = fitLensTable({...cal, samples: rows}, 40)
		expect(wrong.focal).toBeCloseTo((17.95 * 280) / halfWidth(320, 150), 6)
	})

	it('lends a fitted pupil to single-target settings, interpolated by focus', () => {
		const rows = [
			{focus: 0, distance: 300 - 40, halfWidth: halfWidth(300, 160, 100), inFocus: true},
			{focus: 0, distance: 400 - 40, halfWidth: halfWidth(400, 160, 100), inFocus: false},
			{focus: 1, distance: 700 - 40, halfWidth: halfWidth(700, 120, 80), inFocus: true},
			{focus: 1, distance: 800 - 40, halfWidth: halfWidth(800, 120, 80), inFocus: false},
			// Single target half way: the true pupil there is 90.
			{focus: 0.5, distance: 500 - 40, halfWidth: halfWidth(500, 140, 90), inFocus: true},
		]
		const table = fitLensTable({...cal, samples: rows}, 0)
		expect(table.map(r => r.pupilSource)).toEqual(['fitted', 'assumed', 'fitted'])
		expect(table[1].pupil).toBeCloseTo(90, 6)
		expect(table[1].focal).toBeCloseTo(140, 6)
	})

	it('sorts by focus and drops settings without an in-focus reading', () => {
		const rows = [
			{focus: 0.5, distance: 400, halfWidth: 40, inFocus: true},
			{focus: 0.1, distance: 260, halfWidth: 20, inFocus: true},
			{focus: 0.3, distance: 330, halfWidth: 30, inFocus: false},
		]
		expect(fitLensTable({...cal, samples: rows}, 90).map(r => r.focus)).toEqual([0.1, 0.5])
	})
})

describe('lens table lookup', () => {
	const table = [
		{focus: 0, distance: 300, focal: 140, pupil: 90, pupilSource: 'fitted' as const},
		{focus: 0.5, distance: 400, focal: 130, pupil: 85, pupilSource: 'fitted' as const},
		{focus: 1, distance: 600, focal: 110, pupil: 80, pupilSource: 'fitted' as const},
	]

	it('interpolates and clamps by focus', () => {
		expect(lensAtFocus(table, 0.25)).toEqual({distance: 350, focal: 135, pupil: 87.5})
		expect(lensAtFocus(table, 0.75).distance).toBe(500)
		expect(lensAtFocus(table, -1).focal).toBe(140)
		expect(lensAtFocus(table, 2).focal).toBe(110)
	})

	it('inverts distance to focus', () => {
		expect(focusForDistance(table, 350)).toBeCloseTo(0.25, 9)
		expect(focusForDistance(table, 500)).toBeCloseTo(0.75, 9)
		expect(focusForDistance(table, 100)).toBe(0)
		expect(focusForDistance(table, 900)).toBe(1)
	})

	it('writes the Houdini file rounded', () => {
		const json = lensCalibrationJson(DEFAULT_LENS_CALIBRATION, table)
		expect(json.sensor.width).toBe(35.9)
		expect(json.lens.table[1]).toEqual({focus: 0.5, distance: 400, focal: 130, pupil: 85})
	})
})

describe('distance along the optical axis', () => {
	it('projects the target onto the axis from the rotation centre', () => {
		// Camera looking down (−Y) from 500 mm up; the target is 20 mm off-axis.
		expect(distanceAlongAxis([0, 500, 0], [0, -1, 0], [20, 0, 0])).toBe(500)
		// Looking along −Z (straight ahead) at a point 300 ahead.
		expect(distanceAlongAxis([0, 0, 100], [0, 0, -1], [0, 0, -200])).toBe(300)
	})
})
