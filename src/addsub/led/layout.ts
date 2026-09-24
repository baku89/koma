/**
 * LED placement map (ADDSUB.md §8): where every pixel of the wall sits, as a
 * point on the unwrapped 4-face image (face, u, y) and in world space.
 *
 * Strips are horizontal, stacked at `stripSpacing` from `topY` downward; each
 * face has two data lines, line 1 the upper `stripsPerLine` strips and line 2
 * the lower ones; within a line the strips snake (zigzag), the first strip
 * starting from `startSide`. Data line order is the ws-fanout order
 * L1 L2 B1 B2 R1 R2 F1 F2.
 *
 * "u" runs left → right as seen from the *inside* of the wall facing the
 * face, so laying L B R F side by side gives a continuous walk around.
 */

import type {vec3} from 'linearly'

import {LED_FACES, type LedFace, type LedLayoutParams} from '../config'

export interface LedPixel {
	/** Data line index (0-7). */
	line: number
	/** Index within the line. */
	index: number
	face: LedFace
	faceIndex: number
	/** Horizontal position on the face (mm from the left edge, inside view). */
	u: number
	/** World Y (mm). Fixed — the *film* Y is this minus the current lift. */
	y: number
	/** World position of the pixel. */
	world: vec3
}

export interface LedLayout {
	params: LedLayoutParams
	pixels: LedPixel[]
	/** Pixel count per line, in line order. */
	lineCounts: number[]
	pitch: number
}

/** World position for a point on a face (inside view, u from the left). */
export function faceToWorld(face: LedFace, u: number, y: number, faceWidth: number): vec3 {
	const h = faceWidth / 2
	switch (face) {
		case 'L': // x = −h, left (u=0) is +Z
			return [-h, y, h - u]
		case 'B': // z = −h, left is −X
			return [-h + u, y, -h]
		case 'R': // x = +h, left is −Z
			return [h, y, -h + u]
		case 'F': // z = +h, left is +X
			return [h - u, y, h]
	}
}

export function buildLedLayout(params: LedLayoutParams): LedLayout {
	const pitch = params.stripLength / params.pixelsPerStrip
	const margin = (params.faceWidth - params.stripLength) / 2
	const pixels: LedPixel[] = []
	const lineCounts: number[] = []

	LED_FACES.forEach((face, faceIndex) => {
		for (let half = 0; half < 2; half++) {
			const line = faceIndex * 2 + half
			let index = 0
			for (let s = 0; s < params.stripsPerLine; s++) {
				const stripRow = half * params.stripsPerLine + s
				const y = params.topY - stripRow * params.stripSpacing
				const forward = (s % 2 === 0) === (params.startSide === 'left')
				for (let p = 0; p < params.pixelsPerStrip; p++) {
					const k = forward ? p : params.pixelsPerStrip - 1 - p
					const u = margin + (k + 0.5) * pitch
					pixels.push({
						line,
						index: index++,
						face,
						faceIndex,
						u,
						y,
						world: faceToWorld(face, u, y, params.faceWidth),
					})
				}
			}
			lineCounts.push(index)
		}
	})

	return {params, pixels, lineCounts, pitch}
}

/** Vertical extent of the wall (world Y of the lowest strip). */
export function ledBottomY(params: LedLayoutParams) {
	return params.topY - (2 * params.stripsPerLine - 1) * params.stripSpacing
}
