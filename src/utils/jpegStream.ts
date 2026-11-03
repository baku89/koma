/**
 * Split a stream of concatenated JPEGs (ffmpeg's `-f image2pipe -c:v mjpeg`)
 * into pictures. Inside a JPEG every 0xFF of the entropy-coded data is
 * stuffed (0xFF 0x00) or a restart marker, so the first EOI (FF D9) after
 * the SOI (FF D8) ends the picture — ffmpeg's frames carry no embedded
 * thumbnails that could hold one earlier.
 */
export class JpegStreamSplitter {
	private chunks: Uint8Array[] = []
	private size = 0

	push(chunk: Uint8Array) {
		if (chunk.length === 0) return
		this.chunks.push(chunk)
		this.size += chunk.length
	}

	/** The next complete picture, or null until more bytes arrive. */
	next(): Uint8Array | null {
		if (this.size === 0) return null
		const buf = this.chunks.length === 1 ? this.chunks[0] : concat(this.chunks, this.size)
		const start = indexOfMarker(buf, 0xd8, 0)
		if (start < 0) {
			// Garbage before any picture: keep only the last byte in case it is
			// the 0xFF of a marker split across chunks.
			this.chunks = [buf.subarray(buf.length - 1)]
			this.size = 1
			return null
		}
		const end = indexOfMarker(buf, 0xd9, start + 2)
		if (end < 0) {
			this.chunks = [buf]
			this.size = buf.length
			return null
		}
		const picture = buf.slice(start, end + 2)
		const rest = buf.subarray(end + 2)
		this.chunks = rest.length ? [rest] : []
		this.size = rest.length
		return picture
	}
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
	const out = new Uint8Array(size)
	let at = 0
	for (const c of chunks) {
		out.set(c, at)
		at += c.length
	}
	return out
}

function indexOfMarker(buf: Uint8Array, second: number, from: number): number {
	for (let i = from; i < buf.length - 1; i++) {
		if (buf[i] === 0xff && buf[i + 1] === second) return i
	}
	return -1
}
