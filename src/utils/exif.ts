/**
 * EXIF orientation of a camera JPEG or DNG. Browsers rotate an <img> by the
 * tag (`image-orientation: from-image`) and raw converters rotate the DNG,
 * while koma's lv previews are made from the raw pixels — so a camera mounted
 * on its side showed the Hi-Res picture turned 90° against the lv. Instead of
 * stripping the EXIF (the capture time and exposure in it have been used to
 * recover projects), the Orientation entry alone is set to 1 ("as stored")
 * before the file is saved. A DNG is a TIFF, so its IFD0 is read the same way
 * (only a file with a DNGVersion tag is touched — not other TIFF-based raws).
 */

const SOI = 0xffd8
const APP1 = 0xffe1
const SOS = 0xffda
const ORIENTATION = 0x0112
const DNG_VERSION = 0xc612

/** How far into a file the IFD0 of a camera JPEG / DNG is looked for. */
const HEAD_BYTES = 1 << 20

/** Orientation SHORT in the IFD0 of a TIFF at `tiff` (null when there is none). */
function findInTiff(
	dv: DataView,
	tiff: number,
	requireDng: boolean
): {at: number; little: boolean} | null {
	if (tiff + 8 > dv.byteLength) return null
	const little = dv.getUint16(tiff) === 0x4949
	if (!little && dv.getUint16(tiff) !== 0x4d4d) return null
	if (dv.getUint16(tiff + 2, little) !== 0x2a) return null
	const ifd0 = tiff + dv.getUint32(tiff + 4, little)
	if (ifd0 + 2 > dv.byteLength) return null
	const n = dv.getUint16(ifd0, little)
	let found: {at: number; little: boolean} | null = null
	let dng = false
	for (let i = 0; i < n; i++) {
		const e = ifd0 + 2 + i * 12
		if (e + 12 > dv.byteLength) return null
		const tag = dv.getUint16(e, little)
		if (tag === ORIENTATION && dv.getUint16(e + 2, little) === 3) found = {at: e + 8, little}
		if (tag === DNG_VERSION) dng = true
	}
	return requireDng && !dng ? null : found
}

/** The byte offset of the Orientation SHORT in IFD0, and the byte order. */
function findOrientation(dv: DataView): {at: number; little: boolean} | null {
	if (dv.byteLength < 4) return null
	const magic = dv.getUint16(0)
	if (magic === 0x4949 || magic === 0x4d4d) return findInTiff(dv, 0, true) // DNG
	if (magic !== SOI) return null
	let p = 2
	while (p + 4 <= dv.byteLength) {
		const marker = dv.getUint16(p)
		if (marker === SOS) return null
		const len = dv.getUint16(p + 2)
		if (marker === APP1 && len >= 14 && p + 2 + len <= dv.byteLength) {
			const seg = p + 4
			// "Exif\0\0" then the TIFF header
			if (dv.getUint32(seg) === 0x45786966 && dv.getUint16(seg + 4) === 0) {
				return findInTiff(dv, seg + 6, false)
			}
		}
		p += 2 + len
	}
	return null
}

/** The Orientation tag's value (1–8), or null when the JPEG has none. */
export function exifOrientation(buf: ArrayBuffer): number | null {
	const dv = new DataView(buf)
	const o = findOrientation(dv)
	return o ? dv.getUint16(o.at, o.little) : null
}

/**
 * The same JPEG / DNG with its Orientation set to 1, so every viewer shows the
 * pixels as stored. Bytes are untouched otherwise; a file without the tag (or
 * already at 1) comes back as is. Only the head of the file is read and
 * copied (a DNG is tens of MB; its IFD0 sits at the front).
 */
export async function resetExifOrientation(blob: Blob): Promise<Blob> {
	const headLen = Math.min(blob.size, HEAD_BYTES)
	const head = await blob.slice(0, headLen).arrayBuffer()
	const dv = new DataView(head)
	const o = findOrientation(dv)
	if (!o || dv.getUint16(o.at, o.little) === 1) return blob
	dv.setUint16(o.at, 1, o.little)
	return new Blob([head, blob.slice(headLen)], {type: blob.type})
}
