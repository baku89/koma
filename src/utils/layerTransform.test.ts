import {describe, expect, it} from 'vitest'

import {
	applyLayerTransform,
	isIdentityTransform,
	layerTransformCss,
	layerTransformOf,
} from './layerTransform'

describe('layerTransform', () => {
	it('treats a missing or default transform as identity', () => {
		expect(isIdentityTransform(undefined)).toBe(true)
		expect(isIdentityTransform({scale: 1})).toBe(true)
		expect(isIdentityTransform({scale: 0.9})).toBe(false)
		expect(layerTransformCss(undefined)).toBeUndefined()
		expect(layerTransformOf({x: 5})).toEqual({scale: 1, x: 5, y: 0, rotate: 0})
	})

	it('writes the CSS in translate → rotate → scale order', () => {
		expect(layerTransformCss({scale: 0.9, x: 2, y: -1.5, rotate: 3})).toBe(
			'translate(2%, -1.5%) rotate(3deg) scale(0.9)'
		)
	})

	it('maps the canvas the same way as the CSS (about the centre, then shifted)', () => {
		const calls: [string, number[]][] = []
		const ctx = {
			translate: (...a: number[]) => calls.push(['translate', a]),
			rotate: (...a: number[]) => calls.push(['rotate', a]),
			scale: (...a: number[]) => calls.push(['scale', a]),
		} as unknown as CanvasRenderingContext2D
		applyLayerTransform(ctx, {scale: 0.9, x: 10, y: 0, rotate: 0}, 200, 100)
		// centre (100, 50) shifted by 10 % of the width = (120, 50)
		expect(calls).toEqual([
			['translate', [120, 50]],
			['rotate', [0]],
			['scale', [0.9, 0.9]],
			['translate', [-100, -50]],
		])
		calls.length = 0
		applyLayerTransform(ctx, undefined, 200, 100)
		expect(calls).toEqual([])
	})
})
