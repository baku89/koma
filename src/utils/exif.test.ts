import {describe, expect, it} from 'vitest'

import {exifOrientation, resetExifOrientation} from './exif'

/** A JPEG skeleton: SOI, an APP0, an APP1 Exif with IFD0 {Make, Orientation}, SOS. */
function jpegWith(orientation: number | null, little = false) {
	const le = little
	const tiff = new DataView(new ArrayBuffer(8 + 2 + 12 * 2 + 4))
	tiff.setUint16(0, le ? 0x4949 : 0x4d4d)
	tiff.setUint16(2, 0x2a, le)
	tiff.setUint32(4, 8, le)
	tiff.setUint16(8, orientation === null ? 1 : 2, le)
	// Make (ASCII, points elsewhere — never read)
	tiff.setUint16(10, 0x010f, le)
	tiff.setUint16(12, 2, le)
	tiff.setUint32(14, 6, le)
	tiff.setUint32(18, 40, le)
	if (orientation !== null) {
		tiff.setUint16(22, 0x0112, le)
		tiff.setUint16(24, 3, le)
		tiff.setUint32(26, 1, le)
		tiff.setUint16(30, orientation, le)
	}
	const exif = new Uint8Array(6 + tiff.byteLength)
	exif.set([0x45, 0x78, 0x69, 0x66, 0, 0])
	exif.set(new Uint8Array(tiff.buffer), 6)
	const app1 = [0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff, ...exif]
	const app0 = [0xff, 0xe0, 0, 4, 0x4a, 0x46]
	return new Uint8Array([0xff, 0xd8, ...app0, ...app1, 0xff, 0xda, 0, 2, 1, 2, 3])
}

/** A DNG skeleton: a TIFF whose IFD0 has Orientation and (unless plain) DNGVersion. */
function dngWith(orientation: number, dng = true, little = true) {
	const le = little
	const dv = new DataView(new ArrayBuffer(8 + 2 + 12 * 2 + 4 + 16))
	dv.setUint16(0, le ? 0x4949 : 0x4d4d)
	dv.setUint16(2, 0x2a, le)
	dv.setUint32(4, 8, le)
	dv.setUint16(8, 2, le)
	dv.setUint16(10, 0x0112, le)
	dv.setUint16(12, 3, le)
	dv.setUint32(14, 1, le)
	dv.setUint16(18, orientation, le)
	// DNGVersion (BYTE ×4) or, for a plain TIFF, an ImageWidth
	dv.setUint16(22, dng ? 0xc612 : 0x0100, le)
	dv.setUint16(24, dng ? 1 : 3, le)
	dv.setUint32(26, dng ? 4 : 1, le)
	dv.setUint32(30, dng ? 0x00000401 : 6000, le)
	return new Uint8Array(dv.buffer)
}

describe('resetExifOrientation', () => {
	it('handles a DNG (TIFF) the same way, and leaves other TIFFs alone', async () => {
		const src = dngWith(6)
		expect(exifOrientation(src.buffer)).toBe(6)
		const out = new Uint8Array(await (await resetExifOrientation(new Blob([src]))).arrayBuffer())
		expect(exifOrientation(out.buffer)).toBe(1)
		expect(out.length).toBe(src.length)
		expect(exifOrientation(dngWith(8, true, false).buffer)).toBe(8)
		const tiff = new Blob([dngWith(6, false)])
		expect(await resetExifOrientation(tiff)).toBe(tiff)
	})

	it('copies only the head of a big file', async () => {
		const src = dngWith(6)
		const big = new Blob([src, new Uint8Array(2 << 20)])
		const out = await resetExifOrientation(big)
		expect(out.size).toBe(big.size)
		expect(exifOrientation(await out.slice(0, 64).arrayBuffer())).toBe(1)
	})

	it('reads the tag in both byte orders', () => {
		expect(exifOrientation(jpegWith(6).buffer)).toBe(6)
		expect(exifOrientation(jpegWith(8, true).buffer)).toBe(8)
		expect(exifOrientation(jpegWith(null).buffer)).toBeNull()
	})

	it('sets only the Orientation bytes to 1', async () => {
		const src = jpegWith(6)
		const out = new Uint8Array(await (await resetExifOrientation(new Blob([src]))).arrayBuffer())
		expect(exifOrientation(out.buffer)).toBe(1)
		let diff = 0
		for (let i = 0; i < src.length; i++) if (src[i] !== out[i]) diff++
		expect(diff).toBe(1)
		expect(out.length).toBe(src.length)
	})

	it('returns the blob itself when there is nothing to change', async () => {
		const plain = new Blob([jpegWith(null)])
		expect(await resetExifOrientation(plain)).toBe(plain)
		const upright = new Blob([jpegWith(1)])
		expect(await resetExifOrientation(upright)).toBe(upright)
		const notJpeg = new Blob([new Uint8Array([1, 2, 3])])
		expect(await resetExifOrientation(notJpeg)).toBe(notJpeg)
	})
})
