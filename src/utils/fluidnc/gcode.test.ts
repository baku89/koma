import {describe, expect, it} from 'vitest'

import {rewriteMoveLine} from './gcode'
import type {AxesPosition} from './status'

/** Pretend the frame is 10 mm to the right of machine X and 5 ° off on B. */
const convert = (axes: AxesPosition): AxesPosition => {
	const out: AxesPosition = {...axes}
	if (out.x !== undefined) out.x += 10
	if (out.b !== undefined) out.b += 5
	return out
}

describe('rewriteMoveLine', () => {
	it('converts the axis words of an absolute G0 / G1 and marks it G53', () => {
		expect(rewriteMoveLine('G0 X100 Y-20', convert)).toBe('G53 G0 X110 Y-20')
		expect(rewriteMoveLine('G1 X1.5 B30 F600', convert)).toBe('G53 G1 F600 X11.5 B35')
		expect(rewriteMoveLine('g90 g1 z12', convert)).toBe('G53 G90 G1 Z12')
	})

	it('rewrites a jog as a G53 jog', () => {
		expect(rewriteMoveLine('$J=G90 G21 X100 F1500', convert)).toBe('$J=G90 G53 G21 F1500 X110')
		expect(rewriteMoveLine('$J=X5 F100', convert)).toBe('$J=G90 G53 X5 F100'.replace('X5 F100', 'F100 X15'))
	})

	it('treats bare axis words as a move on the modal G0 / G1', () => {
		expect(rewriteMoveLine('Z0', convert)).toBe('G53 Z0')
		expect(rewriteMoveLine('x10 y20 f500', convert)).toBe('G53 F500 X20 Y20')
		expect(rewriteMoveLine('G90 G21 B10', convert)).toBe('G53 G90 G21 B15')
	})

	it('leaves relative, machine and non-move lines alone', () => {
		for (const line of [
			'G91 G0 X10', 'G53 G0 X10', '$J=G91 X1 F100', '$H', 'M8', 'G10 L20 P1 X0', 'G0',
			'G28 X0', 'G92 X0 Y0', 'G38.2 Z-10 F100', 'M3 S1000', 'G4 P1', 'F500',
		]) {
			expect(rewriteMoveLine(line, convert)).toBe(line)
		}
	})

	it('can fill in the axes the line left out', () => {
		const here: AxesPosition = {x: 1, y: 2, z: 3}
		const fill = (axes: AxesPosition) => convert({...here, ...axes})
		expect(rewriteMoveLine('G0 Z0', fill)).toBe('G53 G0 X11 Y2 Z0')
	})
})
