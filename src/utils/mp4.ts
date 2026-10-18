/**
 * Encode a run of images into an MP4 in the browser (WebCodecs H.264 +
 * mp4-muxer, no native dependency). Used by the exhibition's screen A (which
 * caches the result in OPFS, see exhibit/encode.ts) and by koma's own
 * "Export MP4" command.
 */

import {ArrayBufferTarget, Muxer} from 'mp4-muxer'

export interface EncodeSource {
	/**
	 * Resolves to the frame's picture — encoded bytes, or something already
	 * drawable (a composited canvas, a bitmap) — or null to skip it.
	 */
	blob(): Promise<Blob | ImageBitmap | OffscreenCanvas | null>
}

export interface EncodeOptions {
	fps: number
	/** Output size; frames are letterboxed into it. */
	width: number
	height: number
	bitrate?: number
	onProgress?: (done: number, total: number) => void
	/** Which codec the encoder settled on (`avc` = H.264, playable anywhere). */
	onCodec?: (codec: 'avc' | 'vp9' | 'av1') => void
	signal?: AbortSignal
}

/**
 * H.264 configs by level. The level caps the frame size (in macroblocks):
 * 4.2 ends at 1920×1080, so a 3:2 1920×1280 picture needs 5.1; 6.2 goes to
 * 8192×4320 on paper, though Chrome's encoder refuses 6000×4000 either way.
 */
const H264_CODECS = ['avc1.640033', 'avc1.64003e', 'avc1.64002a', 'avc1.42001f']

const encoderConfig = (
	codec: string,
	width: number,
	height: number,
	fps: number,
	bitrate: number
): VideoEncoderConfig => ({
	codec,
	width,
	height,
	bitrate,
	framerate: fps,
	latencyMode: 'quality',
	...(codec.startsWith('avc1') ? {avc: {format: 'avc' as const}} : {}),
})

async function isSupported(cfg: VideoEncoderConfig) {
	try {
		return !!(await VideoEncoder.isConfigSupported(cfg)).supported
	} catch {
		return false
	}
}

/**
 * The largest size, keeping the aspect of `width`×`height` and never larger,
 * that this browser can encode as H.264 — the camera's 6000×4000 can't be,
 * so a hi-res export steps down the ladder. Null when H.264 isn't available
 * at all (a Chromium without proprietary codecs).
 */
export async function fitH264Size(
	width: number,
	height: number,
	fps = 30
): Promise<[number, number] | null> {
	const long = Math.max(width, height)
	const ladder = [long, 4096, 3840, 2560, 1920, 1280].filter((v, i, a) => v <= long && a.indexOf(v) === i)
	for (const cap of ladder) {
		const s = cap / long
		const w = even(width * s)
		const h = even(height * s)
		for (const codec of H264_CODECS) {
			if (await isSupported(encoderConfig(codec, w, h, fps, 12_000_000))) return [w, h]
		}
	}
	return null
}

export function isEncodingSupported() {
	return typeof VideoEncoder === 'function' && typeof OffscreenCanvas === 'function'
}

function even(n: number) {
	return Math.max(2, Math.round(n / 2) * 2)
}

export async function encodeTakesToMp4(
	sources: EncodeSource[],
	opts: EncodeOptions
): Promise<Blob> {
	const width = even(opts.width)
	const height = even(opts.height)
	const fps = opts.fps

	// H.264 (hardware on the Mac mini, plays in QuickTime) first; Chromium
	// builds without proprietary codecs (e.g. Playwright's) fall back to
	// VP9 / AV1, which mp4-muxer can also wrap but QuickTime can't play.
	const candidates: {codec: string; mux: 'avc' | 'vp9' | 'av1'}[] = [
		...H264_CODECS.map(codec => ({codec, mux: 'avc' as const})),
		{codec: 'vp09.00.40.08', mux: 'vp9'},
		{codec: 'av01.0.08M.08', mux: 'av1'},
	]
	let chosen: (typeof candidates)[number] | null = null
	let config: VideoEncoderConfig | null = null
	for (const c of candidates) {
		const cfg = encoderConfig(c.codec, width, height, fps, opts.bitrate ?? 12_000_000)
		if (await isSupported(cfg)) {
			chosen = c
			config = cfg
			break
		}
	}
	if (!chosen || !config) throw new Error('No supported video encoder (H.264 / VP9 / AV1)')
	opts.onCodec?.(chosen.mux)

	const muxer = new Muxer({
		target: new ArrayBufferTarget(),
		video: {codec: chosen.mux, width, height},
		fastStart: 'in-memory',
	})

	let error: unknown = null
	const encoder = new VideoEncoder({
		output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
		error: e => {
			error = e
		},
	})
	encoder.configure(config)

	const canvas = new OffscreenCanvas(width, height)
	const ctx = canvas.getContext('2d')
	if (!ctx) throw new Error('2D context unavailable')

	const frameDuration = 1_000_000 / fps
	let index = 0

	for (let i = 0; i < sources.length; i++) {
		if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
		if (error) throw error

		const src = await sources[i].blob()
		if (!src) continue
		let bitmap: ImageBitmap | OffscreenCanvas
		if (src instanceof Blob) {
			try {
				bitmap = await createImageBitmap(src)
			} catch {
				continue
			}
		} else {
			bitmap = src
		}

		// Letterbox into the output.
		ctx.fillStyle = '#000'
		ctx.fillRect(0, 0, width, height)
		const scale = Math.min(width / bitmap.width, height / bitmap.height)
		const w = bitmap.width * scale
		const h = bitmap.height * scale
		ctx.drawImage(bitmap, (width - w) / 2, (height - h) / 2, w, h)
		if (bitmap instanceof ImageBitmap) bitmap.close()

		const frame = new VideoFrame(canvas, {
			timestamp: Math.round(index * frameDuration),
			duration: Math.round(frameDuration),
		})
		// Keyframe every 2 s so seeking / looping stays cheap.
		encoder.encode(frame, {keyFrame: index % (fps * 2) === 0})
		frame.close()
		index++

		// Don't let the encoder queue run away on slow machines.
		while (encoder.encodeQueueSize > 8) {
			await new Promise(r => setTimeout(r, 10))
		}
		opts.onProgress?.(i + 1, sources.length)
	}

	await encoder.flush()
	encoder.close()
	if (error) throw error
	muxer.finalize()

	const {buffer} = muxer.target as ArrayBufferTarget
	return new Blob([buffer], {type: 'video/mp4'})
}

