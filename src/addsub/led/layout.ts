/**
 * LED placement map (ADDSUB.md §8): where every pixel of the wall sits in
 * world space, and where it samples the unwrapped lighting image.
 *
 * Two sources:
 * - `ledLayoutFromSet()`: the real placement, exported from Houdini into
 *   previz/set.json as per-pixel `[x, y, z, u]` (world mm + horizontal mm on
 *   the unwrapped image) in data-line order. This is the one used on site.
 * - `buildLedLayout()`: a parametric fallback (4 faces L B R F side by side,
 *   horizontal strips snaking downward from `topY`, two lines per face) for
 *   when no set.json exists.
 *
 * In both, the vertical sample position is derived from the pixel's world Y
 * minus the current film lift (the wall is fixed; the film frame rises with
 * every appended block), so the map never changes with k_base.
 */

import type {vec3} from 'linearly'

import {LED_FACES, type LedFace, type LedLayoutParams} from '../config'

export interface LedPixel {
	/** Data line index (0-7). */
	line: number
	/** Index within the line. */
	index: number
	/** World position of the pixel (mm). */
	world: vec3
	/** Horizontal position on the unwrapped image (mm from its left edge). */
	u: number
	/** Fallback layout only: which face this pixel is on. */
	face?: LedFace
	faceIndex?: number
	/** World Y (mm), same as world[1]. */
	y: number
}

export interface LedLayout {
	source: 'set' | 'builtin'
	/** Bumped when the physical placement changes; stored with each shot. */
	version: number
	pixels: LedPixel[]
	/** Pixel count per line, in line order. */
	lineCounts: number[]
	/** LED pitch (mm), the default sampling box size. */
	pitch: number
	/** Width of the unwrapped image in mm (u runs 0 … imageWidth). */
	imageWidth: number
	/** Fallback layout only. */
	params?: LedLayoutParams
}

/** `led` section of previz/set.json, as Houdini writes it. */
export interface LedSetData {
	/** Bump when the placement changes. Default 1. */
	layoutVersion?: number
	/** Width of the unwrapped image in mm. */
	imageWidth: number
	/** LED pitch in mm (default 1400 / 42). */
	pitch?: number
	/** In ws-fanout data-line order (L1 L2 B1 B2 R1 R2 F1 F2). */
	lines: {
		name?: string
		/** `[x, y, z, u]` per pixel: world mm and horizontal image mm. */
		pixels: [number, number, number, number][]
	}[]
}

export function ledLayoutFromSet(data: LedSetData): LedLayout {
	const pixels: LedPixel[] = []
	const lineCounts: number[] = []
	data.lines.forEach((ln, line) => {
		ln.pixels.forEach(([x, y, z, u], index) => {
			pixels.push({line, index, world: [x, y, z], u, y})
		})
		lineCounts.push(ln.pixels.length)
	})
	return {
		source: 'set',
		version: data.layoutVersion ?? 1,
		pixels,
		lineCounts,
		pitch: data.pitch ?? 1400 / 42,
		imageWidth: data.imageWidth,
	}
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

export function buildLedLayout(
	params: LedLayoutParams,
	version = 1
): LedLayout {
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
					const uFace = margin + (k + 0.5) * pitch
					pixels.push({
						line,
						index: index++,
						face,
						faceIndex,
						u: faceIndex * params.faceWidth + uFace,
						y,
						world: faceToWorld(face, uFace, y, params.faceWidth),
					})
				}
			}
			lineCounts.push(index)
		}
	})

	return {
		source: 'builtin',
		version,
		params,
		pixels,
		lineCounts,
		pitch,
		imageWidth: 4 * params.faceWidth,
	}
}

/** Vertical extent of the wall (world Y of the lowest strip). */
export function ledBottomY(params: LedLayoutParams) {
	return params.topY - (2 * params.stripsPerLine - 1) * params.stripSpacing
}
