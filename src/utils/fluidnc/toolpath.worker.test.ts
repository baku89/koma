import {describe, expect, it} from 'vitest'

import {compactToolpath, LABEL_EVERY} from './toolpath.worker'

describe('compactToolpath', () => {
	it('flattens a small program into three.js-axis segments', () => {
		const text = ['G90 G21', 'G0 X10 Y0 Z5', 'G1 X10 Y20 Z-1 F600', 'G1 X0 Y20'].join('\n')
		const tp = compactToolpath(text)!
		expect(tp).not.toBeNull()
		expect(tp.rapid.length).toBe(3)
		expect(Array.from(tp.rapid)).toEqual([1, 0, 0])
		expect(Array.from(tp.line)).toEqual([1, 2, 3])
		// mill (x, y, z) → three (x, z, −y): second segment ends at (10, -1, -20)
		expect(Array.from(tp.positions.subarray(9, 12))).toEqual([10, -1, -20])
		expect(tp.lineCount).toBe(4)
		expect(tp.cutLength).toBeCloseTo(Math.hypot(0, 20, 6) + 10, 6)
		// Centre/radius come from the cutting moves only.
		expect(tp.centre[0]).toBeCloseTo(5)
		expect(tp.radius).toBeGreaterThan(1)
	})

	it('labels every LABEL_EVERY-th line and stacks the header', () => {
		const lines = ['G90', 'G21', 'G0 X0 Y0 Z1']
		for (let i = 0; i < LABEL_EVERY * 2; i++) lines.push(`G1 X${i} Y0`)
		const tp = compactToolpath(lines.join('\n'))!
		const numbered = tp.labels.filter(l => l.line >= 0).map(l => l.line)
		expect(numbered).toEqual([LABEL_EVERY, LABEL_EVERY * 2])
		expect(tp.labels.filter(l => l.line < 0).map(l => l.text)).toEqual(['G90', 'G21'])
	})

	it('returns null for a file without moves', () => {
		expect(compactToolpath('G90\nM3 S1000\nM5')).toBeNull()
	})
})

describe('time estimate', () => {
	it('sums feed and rapid moves and exposes cumulative times', () => {
		// 60 mm rapid at 1500 mm/min = 2.4 s, then 60 mm at F600 = 6 s.
		const text = ['G90 G21', 'G0 X60', 'G1 X0 F600'].join('\n')
		const tp = compactToolpath(text)!
		expect(tp.seconds).toBeCloseTo(8.4, 6)
		expect(Array.from(tp.time).map(t => +t.toFixed(3))).toEqual([2.4, 8.4])
	})
})

describe('toolpathTimeAt', () => {
	it('splits elapsed / remaining at the sent line', async () => {
		const {toolpathTimeAt} = await import('./toolpathParser')
		const tp = compactToolpath(['G0 X60', 'G1 X0 F600', 'G1 Y60'].join('\n'))!
		expect(toolpathTimeAt(tp, 0)).toEqual({elapsed: 0, remaining: tp.seconds})
		const mid = toolpathTimeAt(tp, 1) // line 0 sent → first segment done
		expect(mid.elapsed).toBeCloseTo(2.4, 3)
		expect(mid.remaining).toBeCloseTo(tp.seconds - 2.4, 3)
		expect(toolpathTimeAt(tp, 99).remaining).toBeCloseTo(0, 5) // Float32 times
	})
})
