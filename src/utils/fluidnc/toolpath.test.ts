import {describe, expect, it} from 'vitest'

import {parseToolpath} from './toolpath'

describe('parseToolpath', () => {
	it('follows G0/G1 with modal motion and absolute/relative', () => {
		const tp = parseToolpath(['G21 G90', 'G0 X10 Y0 Z5', 'G1 Z-1 F300', 'X20', 'G91 X5', 'G90 G0 Z5'])
		expect(tp.segments.map(s => [s.rapid, s.to])).toEqual([
			[true, [10, 0, 5]],
			[false, [10, 0, -1]],
			[false, [20, 0, -1]],
			[false, [25, 0, -1]],
			[true, [25, 0, 5]],
		])
		expect(tp.segments[2].line).toBe(3)
		expect(tp.cutLength).toBeCloseTo(6 + 10 + 5)
		expect(tp.bounds).toEqual({min: [10, 0, -1], max: [25, 0, 5]})
	})

	it('flattens arcs (G2 with IJ) ending exactly at the target', () => {
		const tp = parseToolpath(['G0 X10 Y0', 'G2 X0 Y10 I-10 J0'], {arcSegmentMm: 1})
		const last = tp.segments[tp.segments.length - 1]
		expect(last.to[0]).toBeCloseTo(0)
		expect(last.to[1]).toBeCloseTo(10)
		// Clockwise from (10,0) to (0,10) about the origin is the long way round:
		// three quarters of r=10 → ~47.1 mm, through negative y first.
		expect(tp.cutLength).toBeCloseTo((Math.PI * 10 * 3) / 2, 1)
		expect(tp.segments[1].to[1]).toBeLessThan(0)
	})

	it('handles G3 with R and inch units', () => {
		const tp = parseToolpath(['G20', 'G0 X1 Y0', 'G3 X0 Y1 R1'], {arcSegmentMm: 2})
		const last = tp.segments[tp.segments.length - 1]
		expect(last.to[0]).toBeCloseTo(0)
		expect(last.to[1]).toBeCloseTo(25.4)
		expect(tp.cutLength).toBeCloseTo((Math.PI * 25.4) / 2, 0)
	})

	it('ignores comments and non-motion lines', () => {
		const tp = parseToolpath(['(header)', 'M3 S12000', 'G1 X5 ; feed', 'M5'])
		expect(tp.segments.length).toBe(1)
		expect(tp.segments[0].line).toBe(2)
	})
})
