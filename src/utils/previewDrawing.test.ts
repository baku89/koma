import {describe, expect, it} from 'vitest'

import {
	eraserHitsStroke,
	extendStrokePath,
	startStrokePath,
	strokePathPoints,
} from './previewDrawing'

describe('stroke paths', () => {
	it('round-trips points, rounded to 0.1 px', () => {
		const d = extendStrokePath(startStrokePath([10.04, -2.5]), [1920, 1280.26])
		expect(d).toBe('M10 -2.5L10 -2.5L1920 1280.3')
		expect(strokePathPoints(d)).toEqual([
			[10, -2.5],
			[10, -2.5],
			[1920, 1280.3],
		])
	})
})

describe('eraserHitsStroke', () => {
	const stroke = strokePathPoints('M0 0L100 0L100 100')

	it('hits when the move crosses a segment', () => {
		expect(eraserHitsStroke(stroke, [50, -10], [50, 10], 0)).toBe(true)
	})

	it('hits within the tolerance, even without moving', () => {
		expect(eraserHitsStroke(stroke, [50, 3], [50, 3], 4)).toBe(true)
		expect(eraserHitsStroke(stroke, [50, 5], [50, 5], 4)).toBe(false)
	})

	it('misses a move that passes by', () => {
		expect(eraserHitsStroke(stroke, [0, 50], [50, 50], 4)).toBe(false)
	})

	it('hits a dot', () => {
		const dot = strokePathPoints(startStrokePath([10, 10]))
		expect(eraserHitsStroke(dot, [0, 10], [20, 10], 1)).toBe(true)
	})
})
