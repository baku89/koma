/**
 * "Export MP4": a range of the timeline composited the way the Preview shows
 * it — the layers of the active preset up to the current one, each with its
 * opacity and blend mode, cover-fitted into the output — and encoded with
 * utils/mp4. Frames with nothing on them hold the previous picture, so the
 * timing of the film is kept.
 */

import {type EncodeSource,encodeTakesToMp4} from './mp4'

export type ExportBlendMode = 'normal' | 'lighten' | 'darken' | 'difference'

export interface ExportLayer {
	/** Resolves to the layer's image bytes, or null when it has no shot here. */
	blob(): Promise<Blob | null | undefined>
	opacity: number
	mixBlendMode: ExportBlendMode
}

export interface ExportFrame {
	/** Bottom to top. */
	layers: ExportLayer[]
}

export interface ExportVideoOptions {
	fps: number
	width: number
	height: number
	bitrate?: number
	onProgress?: (done: number, total: number) => void
	onCodec?: (codec: 'avc' | 'vp9' | 'av1') => void
	signal?: AbortSignal
}

const compositeOperation: Record<ExportBlendMode, GlobalCompositeOperation> = {
	normal: 'source-over',
	lighten: 'lighten',
	darken: 'darken',
	difference: 'difference',
}

/** `object-fit: cover` */
function drawCover(
	c: OffscreenCanvasRenderingContext2D,
	src: ImageBitmap,
	w: number,
	h: number
) {
	const s = Math.max(w / src.width, h / src.height)
	c.drawImage(src, (w - src.width * s) / 2, (h - src.height * s) / 2, src.width * s, src.height * s)
}

export async function exportFramesToMp4(
	frames: ExportFrame[],
	opts: ExportVideoOptions
): Promise<Blob> {
	const width = Math.max(2, Math.round(opts.width / 2) * 2)
	const height = Math.max(2, Math.round(opts.height / 2) * 2)
	const canvas = new OffscreenCanvas(width, height)
	const ctx = canvas.getContext('2d')
	if (!ctx) throw new Error('2D context unavailable')

	// The last composited picture, held over empty frames.
	let held: OffscreenCanvas | null = null

	const sources: EncodeSource[] = frames.map(frame => ({
		async blob() {
			const bitmaps: {bmp: ImageBitmap; layer: ExportLayer}[] = []
			for (const layer of frame.layers) {
				const b = await layer.blob()
				if (!b) continue
				try {
					bitmaps.push({bmp: await createImageBitmap(b), layer})
				} catch {
					// undecodable file: leave the layer out
				}
			}
			if (bitmaps.length === 0) {
				// Nothing on this frame: hold the previous picture (black before
				// the first one).
				if (!held) {
					held = new OffscreenCanvas(width, height)
					const hc = held.getContext('2d')!
					hc.fillStyle = '#000'
					hc.fillRect(0, 0, width, height)
				}
				return held
			}
			ctx.globalAlpha = 1
			ctx.globalCompositeOperation = 'source-over'
			ctx.fillStyle = '#000'
			ctx.fillRect(0, 0, width, height)
			for (const {bmp, layer} of bitmaps) {
				ctx.globalAlpha = layer.opacity
				ctx.globalCompositeOperation = compositeOperation[layer.mixBlendMode] ?? 'source-over'
				drawCover(ctx, bmp, width, height)
				bmp.close()
			}
			ctx.globalAlpha = 1
			ctx.globalCompositeOperation = 'source-over'
			// Snapshot for the hold (the encoder draws `canvas` right away, but
			// the hold must survive the next frame's redraw).
			held ??= new OffscreenCanvas(width, height)
			held.getContext('2d')!.drawImage(canvas, 0, 0)
			return canvas
		},
	}))

	return encodeTakesToMp4(sources, {
		fps: opts.fps,
		width,
		height,
		bitrate: opts.bitrate,
		onProgress: opts.onProgress,
		onCodec: opts.onCodec,
		signal: opts.signal,
	})
}

/** `<name>_0012-0345_18fps.mp4` */
export function exportVideoFilename(
	name: string,
	from: number,
	to: number,
	fps: number
) {
	const pad = (n: number) => String(n).padStart(4, '0')
	const safe = name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'koma'
	return `${safe}_${pad(from)}-${pad(to)}_${fps}fps.mp4`
}

/** Hand the file to the user: the save dialog when there is one, else a download. */
export async function saveBlobAs(blob: Blob, suggestedName: string) {
	if (typeof window.showSaveFilePicker === 'function') {
		const handle = await window.showSaveFilePicker({
			suggestedName,
			types: [{description: 'MP4 video', accept: {'video/mp4': ['.mp4']}}],
		})
		const w = await handle.createWritable()
		await w.write(blob)
		await w.close()
		return
	}
	const url = URL.createObjectURL(blob)
	const a = document.createElement('a')
	a.href = url
	a.download = suggestedName
	a.click()
	setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
