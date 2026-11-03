/**
 * A video dropped on a timeline cell becomes guide images: one shot per
 * stored frame of the clip, from that cell onwards on its layer (shots there
 * are replaced; they go to the trash ledger like any overwrite). Frames are
 * read one at a time (utils/videoFrames.ts), the hi-res JPEG kept as the
 * shot's `jpg` and a project-resolution `lv` made from it, like a pasted
 * image. Every few frames the project is saved so the bytes reach the disk
 * and leave memory (transient assets) — a 3000-frame clip must not sit in
 * RAM — and so an interrupted import keeps what it had.
 *
 * Progress is in the window title; Esc stops after the current frame.
 */
import {defineStore} from 'pinia'
import {ref} from 'vue'

import {
	frameAssetPath,
	registerCapturedAsset,
	resizeBlobImage,
} from '@/utils'
import {isVideoFilename, openVideoFrames} from '@/utils/videoFrames'

import {useProjectStore} from './project'
import {useViewportStore} from './viewport'

export {isVideoFilename}

/** Frames committed (and saved) per batch. */
const BATCH = 24

export const useVideoImportStore = defineStore('videoImport', () => {
	const project = useProjectStore()
	const viewport = useViewportStore()

	const running = ref<null | {file: string; done: number; total: number | null}>(null)
	let abort: AbortController | null = null

	function cancel() {
		abort?.abort()
	}

	/**
	 * Import `file`'s frames onto `layer` from `frame` on. Resolves with how
	 * many frames were placed (fewer than the clip when stopped).
	 */
	async function importVideo(file: File, frame: number, layer: number): Promise<number> {
		if (running.value) throw new Error(`Already importing ${running.value.file}`)
		const source = await openVideoFrames(file)
		try {
			const total = source.total
			const existing = countShots(frame, layer, total)
			const name = project.layer(layer).name
			const what = total ? `${total} frames` : 'the frames'
			const replace = existing > 0 ? `\n\n${existing} existing shot${existing > 1 ? 's' : ''} on "${name}" from #${frame} will be replaced.` : ''
			const via = source.reader === 'ffmpeg' ? 'ffmpeg' : 'this browser'
			if (
				!confirm(
					`Import ${what} of ${file.name} (${source.width}×${source.height}${
						source.fps ? `, ${+source.fps.toFixed(3)} fps` : ''
					}, via ${via}) as guide images on "${name}" from #${frame}?${replace}`
				)
			) {
				return 0
			}

			abort = new AbortController()
			const {signal} = abort
			running.value = {file: file.name, done: 0, total}
			const title = document.title
			const onKey = (e: KeyboardEvent) => {
				if (e.key === 'Escape') {
					e.stopPropagation()
					cancel()
				}
			}
			window.addEventListener('keydown', onKey, {capture: true})
			try {
				let i = 0
				for (;;) {
					// A batch under one interaction: one history entry, one
					// traversal by the deep watchers instead of one per frame.
					const batch: {jpg: Blob; lv: Blob}[] = []
					while (batch.length < BATCH && !signal.aborted) {
						const jpg = await source.next()
						if (!jpg) break
						const lv = await resizeBlobImage(jpg, project.resolution, 'contain')
						batch.push({jpg, lv})
						running.value = {file: file.name, done: i + batch.length, total}
						document.title = `Importing ${i + batch.length}${total ? `/${total}` : ''}… – ${title}`
					}
					if (batch.length === 0) break
					project.beginInteraction()
					try {
						for (const {jpg, lv} of batch) {
							const f = frame + i
							project.setShot(f, layer, {
								jpg: registerCapturedAsset(jpg, frameAssetPath(project, layer, f, 'jpg'), {transient: true}),
								lv: registerCapturedAsset(lv, frameAssetPath(project, layer, f, 'lv'), {transient: true}),
								captureDate: Date.now(),
								source: {file: file.name, frame: i},
							})
							i++
						}
					} finally {
						project.endInteraction()
					}
					// Write this batch out (and free its bytes) before reading more.
					await project.flushSave()
					if (signal.aborted) break
				}
				if (i > 0) viewport.setCurrentFrame(frame + i - 1)
				return i
			} finally {
				window.removeEventListener('keydown', onKey, {capture: true})
				document.title = title
				running.value = null
				abort = null
			}
		} finally {
			source.close()
		}
	}

	function countShots(frame: number, layer: number, total: number | null): number {
		let n = 0
		const last = total ? Math.min(project.komas.length, frame + total) : project.komas.length
		for (let f = frame; f < last; f++) if (project.cellShot(f, layer)) n++
		return n
	}

	return {running, importVideo, cancel}
})
