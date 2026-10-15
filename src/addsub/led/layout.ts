/**
 * LED placement map (ADDSUB.md §8): where every pixel of the wall sits in
 * world space (mm, Y-up, origin = the rig's work origin: the centre of the
 * work's bottom face), in ws-fanout data-line order L1 L2 B1 B2 R1 R2 F1 F2.
 *
 * Hard-coded from the Houdini set model (`/obj/LED_box` in
 * 10_addsub_boxrig.hiplc, read 2026-10-16): 1400 mm strips of 42 pixels
 * standing vertically, 100 mm apart, nine or ten per data line, snaking
 * top→bottom→top within a line. Nothing here is editable in the UI; when the
 * wall changes, change these constants (and bump `LED_LAYOUT_VERSION`).
 */

import {vec3} from 'linearly'

import {LED_FACES, LED_LAYOUT_VERSION, type LedFace} from '../config'

export const LED_PIXELS_PER_STRIP = 42
/** Pixel pitch (mm): the 42 pixels span 1370 mm. */
export const LED_PITCH = 1370 / 41
/** World Y of the top and bottom pixel of every strip (mm). */
export const LED_TOP_Y = 1265
export const LED_BOTTOM_Y = LED_TOP_Y - LED_PITCH * (LED_PIXELS_PER_STRIP - 1)
/** Horizontal distance between neighbouring strips (mm). */
export const LED_STRIP_SPACING = 100

/**
 * The LED planes: L/R at x = ∓900, B at z = −900, F at z = +1000. `y` is the
 * pixel extent.
 */
export const LED_WALL = {
	x: [-900, 900] as const,
	z: [-900, 1000] as const,
	y: [LED_BOTTOM_Y, LED_TOP_Y] as const,
}

export const LED_LINE_NAMES = ['L1', 'L2', 'B1', 'B2', 'R1', 'R2', 'F1', 'F2'] as const

/** `count` strips at `at(i)` = [x, z]. */
function strips(count: number, at: (i: number) => [number, number]) {
	return Array.from({length: count}, (_, i) => at(i))
}

/**
 * Where each data line's strips stand ([x, z] of the strip, mm), in data
 * order. Every line but F's has nine strips; F1/F2 have ten, the first of F1
 * and the last of F2 standing round the corner on the R and L walls (at
 * z = 950, 50 mm short of the F plane).
 */
export const LED_STRIPS: readonly (readonly [number, number][])[] = [
	// L1: z 850 → 50
	strips(9, i => [-900, 850 - LED_STRIP_SPACING * i]),
	// L2: z −50 → −850
	strips(9, i => [-900, -50 - LED_STRIP_SPACING * i]),
	// B1: x −50 → −850
	strips(9, i => [-50 - LED_STRIP_SPACING * i, -900]),
	// B2: x 850 → 50
	strips(9, i => [850 - LED_STRIP_SPACING * i, -900]),
	// R1: z −50 → −850
	strips(9, i => [900, -50 - LED_STRIP_SPACING * i]),
	// R2: z 50 → 850
	strips(9, i => [900, 50 + LED_STRIP_SPACING * i]),
	// F1: one on the R wall, then x 850 → 50
	[[900, 950], ...strips(9, i => [850 - LED_STRIP_SPACING * i, 1000])],
	// F2: x −50 → −850, then one on the L wall
	[...strips(9, i => [-50 - LED_STRIP_SPACING * i, 1000]), [-900, 950]],
]

export interface LedPixel {
	/** Data line index (0-7). */
	line: number
	/** Index within the line. */
	index: number
	/** World position of the pixel (mm). */
	world: vec3
	/** Which face's data lines this pixel belongs to (F's corner strips count as F). */
	face: LedFace
	/** World Y (mm), same as world[1]. */
	y: number
}

export interface LedLayout {
	/** Bumped when the physical placement changes; stored with each shot. */
	version: number
	pixels: LedPixel[]
	/** Pixel count per line, in line order. */
	lineCounts: number[]
	/** LED pitch (mm). */
	pitch: number
}

/**
 * The wall: every pixel in data order. Within a line the strips snake —
 * strip 0 runs top→bottom, strip 1 bottom→top, and so on.
 */
export function buildLedLayout(): LedLayout {
	const pixels: LedPixel[] = []
	const lineCounts: number[] = []
	LED_STRIPS.forEach((line, lineIndex) => {
		const face = LED_FACES[Math.floor(lineIndex / 2)]
		let index = 0
		line.forEach(([x, z], s) => {
			const downward = s % 2 === 0
			for (let p = 0; p < LED_PIXELS_PER_STRIP; p++) {
				const q = downward ? p : LED_PIXELS_PER_STRIP - 1 - p
				const y = LED_TOP_Y - q * LED_PITCH
				pixels.push({line: lineIndex, index: index++, face, y, world: [x, y, z]})
			}
		})
		lineCounts.push(index)
	})
	return {version: LED_LAYOUT_VERSION, pixels, lineCounts, pitch: LED_PITCH}
}

/** The one layout there is. */
export const LED_LAYOUT: LedLayout = buildLedLayout()
