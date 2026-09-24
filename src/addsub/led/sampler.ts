/**
 * Sample an unwrapped lighting image (film coordinates) into per-line RGB
 * buffers for ws-fanout (ADDSUB.md §8).
 *
 * The image is the unwrapped wall, `layout.imageWidth` mm wide, at a uniform
 * scale of `width / imageWidth` px per mm. Its top edge is at film Y =
 * `topFilmY`; it extends downward, and is drawn longer than the wall to make
 * room for the stack growing underneath.
 *
 * The LEDs are fixed in world; the film frame rises by BLOCK_HEIGHT·kBase, so
 * each pixel's film Y = world Y − lift. The colour is a box average over a
 * pitch-sized square (LEDs don't align with pixels).
 *
 * DOM-free: takes a plain RGBA buffer, so it runs in tests and workers.
 */

import type {LedLayout} from './layout'

export interface RgbaImage {
	width: number
	height: number
	/** RGBA, row-major, `width * height * 4` bytes. */
	data: Uint8ClampedArray | Uint8Array
}

export interface SampleOptions {
	/** Film Y (mm) at the top edge of the image. */
	topFilmY: number
	/** BLOCK_HEIGHT · kBase (+ base height): world Y = film Y + lift. */
	lift: number
	/**
	 * Side of the averaging box in mm. Default = one LED pitch. 0 = nearest
	 * pixel.
	 */
	boxSize?: number
	/** Multiplier applied to every channel (0-1). Default 1. */
	gain?: number
}

/**
 * @returns one `Uint8Array` (3 bytes/pixel, GRB order is the firmware's job —
 * ws-fanout takes RGB) per data line, in line order.
 */
export function sampleLedFrame(
	layout: LedLayout,
	image: RgbaImage,
	opts: SampleOptions
): Uint8Array[] {
	const scale = image.width / layout.imageWidth // px per mm
	const box = Math.max(0, (opts.boxSize ?? layout.pitch) * scale)
	const half = box / 2
	const gain = opts.gain ?? 1

	const lines = layout.lineCounts.map(n => new Uint8Array(n * 3))
	const {width, height, data} = image

	for (const px of layout.pixels) {
		const cx = px.u * scale
		const filmY = px.world[1] - opts.lift
		const cy = (opts.topFilmY - filmY) * scale

		let r = 0
		let g = 0
		let b = 0
		let n = 0

		const x0 = Math.max(0, Math.floor(cx - half))
		const x1 = Math.min(width - 1, Math.floor(cx + half))
		const y0 = Math.max(0, Math.floor(cy - half))
		const y1 = Math.min(height - 1, Math.floor(cy + half))

		if (x1 >= x0 && y1 >= y0) {
			for (let y = y0; y <= y1; y++) {
				let i = (y * width + x0) * 4
				for (let x = x0; x <= x1; x++, i += 4) {
					const a = data[i + 3] / 255
					r += data[i] * a
					g += data[i + 1] * a
					b += data[i + 2] * a
					n++
				}
			}
		}

		const out = lines[px.line]
		const o = px.index * 3
		if (n > 0) {
			out[o] = clamp255((r / n) * gain)
			out[o + 1] = clamp255((g / n) * gain)
			out[o + 2] = clamp255((b / n) * gain)
		}
	}

	return lines
}

function clamp255(v: number) {
	return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}
