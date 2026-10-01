/**
 * A shot's record of the LED wall: every pixel's RGB exactly as it was sent,
 * so the lighting can be put back without the image it came from — or when
 * there never was one (faces, the live feed, a manual fill). ADDSUB.md §8.
 *
 * One small file per distinct lighting, named by its content hash: shots lit
 * the same way share a file, and writing it twice is harmless.
 *
 *   'KLW1' | u8 line count | u16le pixels per line × lines | RGB of line 0, 1, …
 *
 * Lines are in ws-fanout order (L1 L2 B1 B2 R1 R2 F1 F2).
 */

export const LED_WALL_DIR = 'led-wall'

const MAGIC = [0x4b, 0x4c, 0x57, 0x31] // 'KLW1'

export function encodeWall(lines: readonly Uint8Array[]): Uint8Array {
	const counts = lines.map(l => Math.floor(l.length / 3))
	if (lines.length > 0xff || counts.some(n => n > 0xffff)) {
		throw new RangeError('wall too large to record')
	}
	const header = MAGIC.length + 1 + lines.length * 2
	const out = new Uint8Array(header + counts.reduce((sum, n) => sum + n * 3, 0))
	out.set(MAGIC)
	out[MAGIC.length] = lines.length
	const view = new DataView(out.buffer)
	let offset = header
	lines.forEach((line, i) => {
		view.setUint16(MAGIC.length + 1 + i * 2, counts[i], true)
		out.set(line.subarray(0, counts[i] * 3), offset)
		offset += counts[i] * 3
	})
	return out
}

export function decodeWall(bytes: Uint8Array): Uint8Array[] {
	if (bytes.length <= MAGIC.length || MAGIC.some((b, i) => bytes[i] !== b)) {
		throw new Error('not an LED wall record')
	}
	const lineCount = bytes[MAGIC.length]
	const header = MAGIC.length + 1 + lineCount * 2
	if (bytes.length < header) throw new Error('LED wall record is truncated')
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const lines: Uint8Array[] = []
	let offset = header
	for (let i = 0; i < lineCount; i++) {
		const n = view.getUint16(MAGIC.length + 1 + i * 2, true) * 3
		if (offset + n > bytes.length) throw new Error('LED wall record is truncated')
		lines.push(bytes.slice(offset, offset + n))
		offset += n
	}
	return lines
}

/** Where an encoded record lives in the project folder (by content hash). */
export async function wallRecordPath(encoded: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', encoded as BufferSource))
	const hex = Array.from(digest.subarray(0, 8), b => b.toString(16).padStart(2, '0')).join('')
	return `${LED_WALL_DIR}/${hex}.ledwall`
}
