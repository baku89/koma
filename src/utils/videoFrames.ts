/**
 * Every frame of a video file, one at a time, as JPEG blobs — the source of
 * the guide images a clip dropped on the timeline turns into (one timeline
 * frame per stored video frame, whatever the clip's frame rate).
 *
 * Two readers:
 * - aux (`yarn dev` / `yarn aux`, or the desktop app's built-in one) runs
 *   ffmpeg and streams the pictures over HTTP (aux-manager/lib/video.js):
 *   any codec ffmpeg reads (ProRes included), exact frame stepping, and
 *   nothing read ahead — the stream is pulled picture by picture. The
 *   desktop app sends the file's path; a browser tab uploads the bytes.
 * - without aux, a hidden <video> is seeked frame by frame, which only works
 *   for codecs the browser decodes (H.264 / HEVC on macOS / VP9 / AV1 — not
 *   ProRes) and needs the frame rate, measured from the first second of
 *   playback.
 */
import {native} from '@/electron'
import {AUX_HTTP_URL} from '@/stores/tools'

import {JpegStreamSplitter} from './jpegStream'

export interface VideoFrameSource {
	/** Number of frames, when known up front. */
	total: number | null
	fps: number | null
	width: number
	height: number
	/** How the frames are read. */
	reader: 'ffmpeg' | 'browser'
	/** The next frame as a JPEG, or null after the last one. */
	next(): Promise<Blob | null>
	close(): void
}

export const VIDEO_EXTENSIONS = ['.mov', '.mp4', '.m4v', '.mkv', '.webm', '.avi', '.mxf', '.mts', '.m2ts']

export function isVideoFilename(name: string): boolean {
	const lower = name.toLowerCase()
	return VIDEO_EXTENSIONS.some(ext => lower.endsWith(ext))
}

export async function openVideoFrames(file: File): Promise<VideoFrameSource> {
	try {
		return await openWithAux(file)
	} catch (e) {
		if (!(e instanceof AuxUnavailable)) throw e
		// eslint-disable-next-line no-console
		console.warn(`Reading ${file.name} in the browser: ${e.message}`)
		return openWithVideoElement(file)
	}
}

//------------------------------------------------------------------------------

/** No aux to talk to (not an error of the clip itself): fall back to <video>. */
class AuxUnavailable extends Error {}

interface ClipInfo {
	id: string
	frames: number | null
	fps: number | null
	width: number
	height: number
	codec: string
}

async function openWithAux(file: File): Promise<VideoFrameSource> {
	const path = native?.pathForFile(file)
	let res: Response
	try {
		res = path
			? await fetch(`${AUX_HTTP_URL}/video`, {
					method: 'POST',
					headers: {'content-type': 'application/json'},
					body: JSON.stringify({path}),
				})
			: await fetch(`${AUX_HTTP_URL}/video`, {
					method: 'POST',
					headers: {'content-type': 'application/octet-stream', 'x-koma-name': encodeURIComponent(file.name)},
					body: file,
				})
	} catch (e) {
		throw new AuxUnavailable(`no aux at ${AUX_HTTP_URL} (${e instanceof Error ? e.message : e})`)
	}
	const body = (await res.json().catch(() => ({}))) as Partial<ClipInfo> & {ok?: boolean; error?: string}
	if (res.status === 404 || res.status === 503) throw new AuxUnavailable(body.error ?? `aux answered ${res.status}`)
	if (!res.ok || !body.ok || !body.id) throw new Error(body.error ?? `aux answered ${res.status}`)
	const info = body as ClipInfo

	let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
	const splitter = new JpegStreamSplitter()
	let done = false
	let closed = false

	const forget = () => {
		fetch(`${AUX_HTTP_URL}/video/${info.id}`, {method: 'DELETE'}).catch(() => {})
	}

	return {
		total: info.frames,
		fps: info.fps,
		width: info.width,
		height: info.height,
		reader: 'ffmpeg',
		async next() {
			if (closed) return null
			if (!reader) {
				const r = await fetch(`${AUX_HTTP_URL}/video/${info.id}`)
				if (!r.ok || !r.body) throw new Error(`aux answered ${r.status} for the frames`)
				reader = r.body.getReader()
			}
			for (;;) {
				const picture = splitter.next()
				if (picture) return new Blob([picture as BlobPart], {type: 'image/jpeg'})
				if (done) return null
				const {value, done: end} = await reader.read()
				if (end) done = true
				else splitter.push(value)
			}
		},
		close() {
			if (closed) return
			closed = true
			reader?.cancel().catch(() => {})
			forget()
		},
	}
}

//------------------------------------------------------------------------------

/** Median interval between presented frames over ~1 s of playback → fps. */
async function measureFps(video: HTMLVideoElement): Promise<number> {
	const times: number[] = []
	video.muted = true
	video.playbackRate = 1
	await new Promise<void>((resolve, reject) => {
		let handle = 0
		const done = () => {
			video.cancelVideoFrameCallback(handle)
			video.pause()
			resolve()
		}
		const tick = (_now: number, meta: VideoFrameCallbackMetadata) => {
			times.push(meta.mediaTime)
			if (times.length >= 32 || meta.mediaTime > 1.5) done()
			else handle = video.requestVideoFrameCallback(tick)
		}
		handle = video.requestVideoFrameCallback(tick)
		video.play().catch(reject)
		video.addEventListener('ended', done, {once: true})
	})
	const deltas = times
		.slice(1)
		.map((t, i) => t - times[i])
		.filter(d => d > 0)
		.sort((a, b) => a - b)
	if (deltas.length === 0) throw new Error("Couldn't measure the clip's frame rate")
	const median = deltas[Math.floor(deltas.length / 2)]
	const fps = 1 / median
	// Snap to the usual rates when close; otherwise keep what was measured.
	const common = [8, 10, 12, 12.5, 15, 18, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60]
	const near = common.find(r => Math.abs(r - fps) / r < 0.02)
	return near ?? fps
}

async function openWithVideoElement(file: File): Promise<VideoFrameSource> {
	const url = URL.createObjectURL(file)
	const video = document.createElement('video')
	video.preload = 'auto'
	video.src = url
	const cantDecode = () =>
		new Error(
			`This browser can't decode ${file.name}${
				/\.(mov|mxf)$/i.test(file.name) ? ' (ProRes needs ffmpeg: run yarn dev / yarn aux, or use the desktop app)' : ''
			}`
		)
	try {
		await new Promise<void>((resolve, reject) => {
			video.addEventListener('loadedmetadata', () => resolve(), {once: true})
			video.addEventListener('error', () => reject(cantDecode()), {once: true})
		})
		if (!video.videoWidth) throw cantDecode()
		const fps = await measureFps(video)
		const total = Math.max(1, Math.round(video.duration * fps))
		const canvas = document.createElement('canvas')
		canvas.width = video.videoWidth
		canvas.height = video.videoHeight
		const ctx = canvas.getContext('2d')!
		let index = 0
		let closed = false
		return {
			total,
			fps,
			width: video.videoWidth,
			height: video.videoHeight,
			reader: 'browser',
			async next() {
				if (closed || index >= total) return null
				// The middle of the frame's interval, so rounding lands inside it.
				const t = Math.min((index + 0.5) / fps, Math.max(0, video.duration - 1e-3))
				await new Promise<void>((resolve, reject) => {
					video.addEventListener('seeked', () => resolve(), {once: true})
					video.addEventListener('error', () => reject(new Error('Seek failed')), {once: true})
					video.currentTime = t
				})
				index++
				ctx.drawImage(video, 0, 0)
				return new Promise<Blob>((resolve, reject) =>
					canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Encoding the frame failed'))), 'image/jpeg', 0.92)
				)
			},
			close() {
				if (closed) return
				closed = true
				video.pause()
				video.removeAttribute('src')
				video.load()
				URL.revokeObjectURL(url)
			},
		}
	} catch (e) {
		URL.revokeObjectURL(url)
		throw e
	}
}
