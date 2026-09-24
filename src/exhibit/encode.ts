/**
 * Encode the takes into an MP4 in the browser (WebCodecs H.264 + mp4-muxer),
 * so screen A can loop thousands of frames as a real video instead of
 * swapping images (§15.2 — "ffmpeg とかで動画化", done without a native
 * dependency). The result is cached in OPFS by the take-list signature and
 * rebuilt in the background when new takes appear.
 */

import {ArrayBufferTarget, Muxer} from 'mp4-muxer'

export interface EncodeSource {
	/** Resolves to the frame's image bytes, or null to skip it. */
	blob(): Promise<Blob | null>
}

export interface EncodeOptions {
	fps: number
	/** Output size; frames are letterboxed into it. */
	width: number
	height: number
	bitrate?: number
	onProgress?: (done: number, total: number) => void
	signal?: AbortSignal
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

	// H.264 (hardware on the Mac mini) first; Chromium builds without
	// proprietary codecs (e.g. Playwright's) fall back to VP9 / AV1, which
	// mp4-muxer can also wrap.
	const candidates: {codec: string; mux: 'avc' | 'vp9' | 'av1'; extra?: Partial<VideoEncoderConfig>}[] = [
		{codec: 'avc1.64002a', mux: 'avc', extra: {avc: {format: 'avc'}}},
		{codec: 'avc1.42001f', mux: 'avc', extra: {avc: {format: 'avc'}}},
		{codec: 'vp09.00.40.08', mux: 'vp9'},
		{codec: 'av01.0.08M.08', mux: 'av1'},
	]
	let chosen: (typeof candidates)[number] | null = null
	let config: VideoEncoderConfig | null = null
	for (const c of candidates) {
		const cfg: VideoEncoderConfig = {
			codec: c.codec,
			width,
			height,
			bitrate: opts.bitrate ?? 12_000_000,
			framerate: fps,
			latencyMode: 'quality',
			...c.extra,
		}
		try {
			if ((await VideoEncoder.isConfigSupported(cfg)).supported) {
				chosen = c
				config = cfg
				break
			}
		} catch {
			// try the next one
		}
	}
	if (!chosen || !config) throw new Error('No supported video encoder (H.264 / VP9 / AV1)')

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

		const blob = await sources[i].blob()
		if (!blob) continue
		let bitmap: ImageBitmap
		try {
			bitmap = await createImageBitmap(blob)
		} catch {
			continue
		}

		// Letterbox into the output.
		ctx.fillStyle = '#000'
		ctx.fillRect(0, 0, width, height)
		const scale = Math.min(width / bitmap.width, height / bitmap.height)
		const w = bitmap.width * scale
		const h = bitmap.height * scale
		ctx.drawImage(bitmap, (width - w) / 2, (height - h) / 2, w, h)
		bitmap.close()

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

//------------------------------------------------------------------------------
// OPFS cache

const CACHE_DIR = 'exhibit-video'

async function cacheDir() {
	const root = await navigator.storage.getDirectory()
	return root.getDirectoryHandle(CACHE_DIR, {create: true})
}

function cacheName(signature: string) {
	// Signature may contain characters OPFS dislikes.
	let h = 0
	for (let i = 0; i < signature.length; i++) h = (h * 31 + signature.charCodeAt(i)) | 0
	return `takes-${(h >>> 0).toString(16)}.mp4`
}

export async function readCachedVideo(signature: string): Promise<Blob | null> {
	try {
		const dir = await cacheDir()
		const fh = await dir.getFileHandle(cacheName(signature))
		return await fh.getFile()
	} catch {
		return null
	}
}

export async function writeCachedVideo(signature: string, blob: Blob) {
	const dir = await cacheDir()
	const name = cacheName(signature)
	const fh = await dir.getFileHandle(name, {create: true})
	const w = await fh.createWritable()
	await w.write(blob)
	await w.close()
	// Keep the cache small: drop every other video.
	for await (const [entry] of dir as any) {
		if (entry !== name) await dir.removeEntry(entry).catch(() => {})
	}
}
