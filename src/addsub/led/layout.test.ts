import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

import {describe, expect, it} from 'vitest'

import {
	LED_LAYOUT,
	LED_PIXELS_PER_STRIP,
	LED_STRIP_SPACING,
	LED_STRIPS,
} from './layout'

describe('LED layout', () => {
	it('has 3108 pixels in 8 lines', () => {
		expect(LED_LAYOUT.lineCounts).toEqual([378, 378, 378, 378, 378, 378, 420, 420])
		expect(LED_LAYOUT.pixels.length).toBe(3108)
	})

	it('snakes within a line: even strips run top→bottom', () => {
		const l1 = LED_LAYOUT.pixels.filter(p => p.line === 0)
		expect(l1[0].y).toBeGreaterThan(l1[LED_PIXELS_PER_STRIP - 1].y)
		expect(l1[LED_PIXELS_PER_STRIP].y).toBeLessThan(l1[2 * LED_PIXELS_PER_STRIP - 1].y)
	})
})

/**
 * The ws-fanout firmware carries its own copy of the strip placement
 * (`firmware/src/layout.h`, `layout::RING`), kept in step by hand: it is what
 * the board uses to turn a frame round the box while no host is talking.
 * Check it against this file's strips rather than trust the hand.
 */
describe('firmware layout::RING', () => {
	const header = readFileSync(
		resolve(__dirname, '../../../dev_modules/ws-fanout/firmware/src/layout.h'),
		'utf8'
	)
	const start = header.indexOf('RING[] = {')
	const body = header.slice(start, header.indexOf('};', start))
	const ring = [...body.matchAll(/\{(\d+),\s*(\d+)\}/g)].map(m => ({
		line: Number(m[1]),
		strip: Number(m[2]),
	}))
	const at = (c: {line: number; strip: number}) => LED_STRIPS[c.line][c.strip]

	it('lists every strip of the wall exactly once', () => {
		const all = LED_STRIPS.flatMap((line, l) => line.map((_, s) => `${l}/${s}`))
		expect(ring.map(c => `${c.line}/${c.strip}`).sort()).toEqual(all.sort())
		expect(ring.length).toBe(74)
	})

	it('steps to a neighbouring strip every time, round the whole box', () => {
		for (let i = 0; i < ring.length; i++) {
			const [x0, z0] = at(ring[i])
			const [x1, z1] = at(ring[(i + 1) % ring.length])
			const d = Math.hypot(x1 - x0, z1 - z0)
			// 100 mm along a wall, or a corner (50 mm in each of x and z).
			expect(d, `${i} → ${i + 1}`).toBeLessThanOrEqual(LED_STRIP_SPACING + 1e-9)
		}
	})

	it('runs clockwise seen from +Y', () => {
		// Shoelace over (x, z): positive here means counter-clockwise in the
		// (x, z) plane, which, with +Y toward the viewer, is clockwise seen
		// from above (the L1/L2/R2/F1/F2 data direction).
		let area = 0
		for (let i = 0; i < ring.length; i++) {
			const [x0, z0] = at(ring[i])
			const [x1, z1] = at(ring[(i + 1) % ring.length])
			area += x0 * z1 - z0 * x1
		}
		expect(area).toBeGreaterThan(0)
	})

	it('the firmware pixel index matches the snake here', () => {
		// layout.h: strip * 42 + (odd strip ? 41 − row : row)
		const pixelIndex = (strip: number, row: number) =>
			strip * LED_PIXELS_PER_STRIP +
			(strip & 1 ? LED_PIXELS_PER_STRIP - 1 - row : row)
		for (const c of ring) {
			const [x, z] = at(c)
			for (const row of [0, 1, 41]) {
				const p = LED_LAYOUT.pixels.find(
					p => p.line === c.line && p.index === pixelIndex(c.strip, row)
				)!
				expect(p.world[0]).toBe(x)
				expect(p.world[2]).toBe(z)
				expect(p.y).toBeCloseTo(LED_LAYOUT.pixels[0].y - row * LED_LAYOUT.pitch)
			}
		}
	})
})
