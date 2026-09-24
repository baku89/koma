/**
 * Decode an image file (PNG/JPEG) into a plain RGBA buffer for the sampler.
 * Browser-only (createImageBitmap + OffscreenCanvas).
 */

import type {RgbaImage} from './sampler'

export async function decodeImage(blob: Blob): Promise<RgbaImage> {
	const bitmap = await createImageBitmap(blob, {
		// Lighting images are data, not photos: keep them linear-ish and unscaled.
		colorSpaceConversion: 'none',
		premultiplyAlpha: 'none',
	})
	try {
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
		const ctx = canvas.getContext('2d', {willReadFrequently: true})
		if (!ctx) throw new Error('2D context unavailable')
		ctx.drawImage(bitmap, 0, 0)
		const {data, width, height} = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
		return {width, height, data}
	} finally {
		bitmap.close()
	}
}
