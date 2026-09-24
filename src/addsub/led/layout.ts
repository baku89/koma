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

/** Length of a face along the wall (L/R run along Z, B/F along X). */
export function faceWidth(face: LedFace, params: Pick<LedLayoutParams, 'sizeX' | 'sizeZ'>) {
	return face === 'L' || face === 'R' ? params.sizeZ : params.sizeX
}

/** World position for a point on a face (inside view, u from the left). */
export function faceToWorld(
	face: LedFace,
	u: number,
	y: number,
	params: Pick<LedLayoutParams, 'sizeX' | 'sizeZ'>
): vec3 {
	const hx = params.sizeX / 2
	const hz = params.sizeZ / 2
	switch (face) {
		case 'L': // x = −hx, left (u=0) is +Z
			return [-hx, y, hz - u]
		case 'B': // z = −hz, left is −X
			return [-hx + u, y, -hz]
		case 'R': // x = +hx, left is −Z
			return [hx, y, -hz + u]
		case 'F': // z = +hz, left is +X
			return [hx - u, y, hz]
	}
}

/**
 * Fallback placement: on every face, vertical strips (`height` long, the
 * pixels running down from `topY`) stand `stripSpacing` apart along the
 * face, centred; the first `stripsPerLine` from `startSide` belong to the
 * face's first data line, the rest to its second. Within a line the strips
 * snake: even strips run top→bottom, odd ones bottom→top.
 */
export function buildLedLayout(
	params: LedLayoutParams,
	version = 1
): LedLayout {
	const pitch = params.height / params.pixelsPerStrip
	const pixels: LedPixel[] = []
	const lineCounts: number[] = []
	let uOffset = 0

	LED_FACES.forEach((face, faceIndex) => {
		const width = faceWidth(face, params)
		const stripCount = Math.min(2 * params.stripsPerLine, Math.floor(width / params.stripSpacing))
		const margin = (width - (stripCount - 1) * params.stripSpacing) / 2
		for (let half = 0; half < 2; half++) {
			const line = faceIndex * 2 + half
			let index = 0
			const first = half * params.stripsPerLine
			const last = Math.min(stripCount, first + params.stripsPerLine)
			for (let s = first; s < last; s++) {
				const k = params.startSide === 'left' ? s : stripCount - 1 - s
				const uFace = margin + k * params.stripSpacing
				const downward = (s - first) % 2 === 0
				for (let p = 0; p < params.pixelsPerStrip; p++) {
					const q = downward ? p : params.pixelsPerStrip - 1 - p
					const y = params.topY - (q + 0.5) * pitch
					pixels.push({
						line,
						index: index++,
						face,
						faceIndex,
						u: uOffset + uFace,
						y,
						world: faceToWorld(face, uFace, y, params),
					})
				}
			}
			lineCounts.push(index)
		}
		uOffset += width
	})

	return {
		source: 'builtin',
		version,
		params,
		pixels,
		lineCounts,
		pitch,
		imageWidth: uOffset,
	}
}

/** Vertical extent of the wall (world Y of the bottom of the strips). */
export function ledBottomY(params: LedLayoutParams) {
	return params.topY - params.height
}
