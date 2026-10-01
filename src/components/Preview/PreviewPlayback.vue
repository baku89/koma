<script setup lang="ts">
import {computed, onMounted, onUnmounted, shallowRef, watch} from 'vue'

import {usePreviewCastStore} from '@/stores/previewCast'
import {useProjectStore} from '@/stores/project'
import {useViewportStore} from '@/stores/viewport'
import {resolveBlob} from '@/utils'

const project = useProjectStore()
const viewport = useViewportStore()
const cast = usePreviewCastStore()

const canvas = shallowRef<HTMLCanvasElement | null>(null)

// Smooth playback path. The DOM preview swaps a single <img>'s src per frame,
// which forces the browser to re-decode a full-size JPEG every single frame —
// past ~100 frames that can't keep up and playback stutters. Here we instead
// decode each frame's `lv` once into an already-rasterized ImageBitmap (off the
// main thread, downscaled to the canvas backing size) and just blit it while
// playing. No per-frame decode, so it works on existing projects too.
//
// Only the layer-0 `lv` aspect matches the project resolution, so this path
// always uses `lv` (never the Hi-Res jpg, whose native aspect would distort).
// Hi-Res is for crisp inspection while paused, which the DOM path still serves.
//
// The bitmaps are keyed by the `lv` asset id (stable for an image, whatever
// cell it sits in) and kept across play / stop, and the frames playback would
// start with are decoded while paused — so the first pass is as smooth as the
// later ones instead of stuttering until decoding has caught up.
const cache = new Map<string, ImageBitmap>()
// Ids being decoded (so workers don't claim the same one) and ids that would
// not decode (no file, broken image) — skipped until the next restart.
const inProgress = new Set<string>()
const failed = new Set<string>()
let generation = 0
// Bumped when the cache is thrown away; a decode from before must not land.
let epoch = 0

const blendMode = {
	normal: 'source-over',
	lighten: 'lighten',
	darken: 'darken',
	difference: 'difference',
} as const

// Cap the backing resolution so the bitmap cache stays bounded for long ranges
// (RGBA memory ≈ w·h·4 per frame). The canvas is CSS-scaled to the frame, so a
// modest backing still looks crisp in the preview pane.
const MAX_LONG_SIDE = 1024

const backing = computed<[number, number]>(() => {
	const [w, h] = project.resolution
	const scale = Math.min(1, MAX_LONG_SIDE / Math.max(w, h))
	return [Math.round(w * scale), Math.round(h * scale)]
})

function clearCache() {
	epoch++
	for (const bmp of cache.values()) bmp.close()
	cache.clear()
}

// The composited layers of a frame (visible, in display order, up to the
// current one) that have something to decode (a shot with an `lv`).
function lvLayersAt(frame: number): {layer: number; id: string}[] {
	const shots = project.allKomas[frame]?.shots ?? []
	const out: {layer: number; id: string}[] = []
	for (const layer of project.compositeLayers(viewport.currentLayer)) {
		const id = shots[layer]?.lv
		if (id) out.push({layer, id})
	}
	return out
}

function draw() {
	const c = canvas.value
	if (!c) return

	const ctx = c.getContext('2d')
	if (!ctx) return

	const frame = viewport.previewFrame
	const realLayers = lvLayersAt(frame)

	if (realLayers.length === 0) {
		if (frame === project.captureShot.frame) {
			// The live capture frame (the preview range's out-point). Clear to
			// transparent so the live-view koma rendered under the canvas shows the
			// real-time feed through.
			ctx.clearRect(0, 0, c.width, c.height)
		} else {
			// An empty koma mid-timeline. The capture frame's live-view koma sits
			// persistently under the canvas, so a transparent clear would let the live
			// feed bleed through here too. Paint black (matching `.frame`) so an empty
			// koma reads as black instead of showing the live view or the prior frame.
			ctx.fillStyle = 'black'
			ctx.fillRect(0, 0, c.width, c.height)
		}
		return
	}

	// Keep showing the previous frame until at least one real layer is decoded, so
	// a not-yet-cached frame repeats rather than flashing black.
	if (!realLayers.some(({id}) => cache.has(id))) return

	ctx.clearRect(0, 0, c.width, c.height)

	for (const {layer, id} of realLayers) {
		const bmp = cache.get(id)
		if (!bmp) continue

		const {opacity, mixBlendMode} = project.layerView(layer)
		ctx.globalAlpha = opacity
		ctx.globalCompositeOperation = blendMode[mixBlendMode] ?? 'source-over'
		ctx.drawImage(bmp, 0, 0, c.width, c.height)
	}

	ctx.globalAlpha = 1
	ctx.globalCompositeOperation = 'source-over'
}

// Sliding-window decode: keep a window of frames decoded around the playhead and
// evict the rest, so an arbitrarily long play-through stays bounded in memory
// (decoding the whole range up front did not). Workers always pull the nearest
// not-yet-decoded frame ahead of the playhead — so decoding tracks play order —
// and `prune()` drops frames once they've left the window. While paused the
// window is smaller and sits where playback would start.
const WINDOW_AHEAD = 32
const WINDOW_BEHIND = 8
const CONCURRENCY = 8
const PAUSED_AHEAD = 24
const PAUSED_CONCURRENCY = 4
// Let the playhead settle (scrubbing, stepping) before decoding around it.
const PAUSED_DELAY = 150

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// The frame playback is at — or, while paused, the one it would start from
// (the viewport store restarts from the in-point at the end of a one-shot
// range).
function head() {
	if (viewport.isPlaying) return viewport.previewFrame
	const [inPoint, outPoint] = project.previewRange
	const frame = viewport.currentFrame
	return !project.isLooping && frame === outPoint ? inPoint : frame
}

// The frames the player will run through next, in play order: inside the preview
// range it loops; outside it (before the in-point / past the out-point) it plays
// straight to the project end. Mirrors the viewport store.
function playRange(from: number) {
	const [inPoint, outPoint] = project.previewRange
	const outside = from < inPoint || from > outPoint
	return outside
		? {from, to: project.allKomas.length - 1, loop: false}
		: {from: inPoint, to: outPoint, loop: true}
}

// `count` frames from `start` on, in play order (wrapping when looping).
function framesAhead(start: number, count: number): number[] {
	const {from, to, loop} = playRange(start)
	const span = to - from + 1
	const frames: number[] = []
	let f = Math.min(Math.max(start, from), to)
	for (let i = 0; i < count && i < span; i++) {
		frames.push(f)
		if (++f > to) {
			if (!loop) break
			f = from
		}
	}
	return frames
}

// The frames to keep decoded: the window ahead of the head plus, while
// playing, a few behind it.
function windowFrames(): number[] {
	const start = head()
	if (!viewport.isPlaying) return framesAhead(start, PAUSED_AHEAD)

	const frames = framesAhead(start, WINDOW_AHEAD)
	const {from, to, loop} = playRange(start)
	const span = to - from + 1
	let f = Math.min(Math.max(start, from), to)
	for (let i = 0; i < WINDOW_BEHIND && i < span - 1; i++) {
		if (--f < from) {
			if (!loop) break
			f = to
		}
		frames.push(f)
	}
	return frames
}

// The ids the window needs, as one string: changes whenever what should be
// decoded does (playhead, range, layers, a shot replaced).
const wanted = computed(() =>
	windowFrames()
		.flatMap(frame => lvLayersAt(frame).map(l => l.id))
		.join(' ')
)

// Drop cached bitmaps that have fallen outside the window.
function prune() {
	const keep = new Set(wanted.value.split(' '))
	for (const [id, bmp] of cache) {
		if (!keep.has(id)) {
			bmp.close()
			cache.delete(id)
		}
	}
}

// The nearest frame/layer ahead of the head that still needs decoding; claims
// it via `inProgress` so concurrent workers don't duplicate work.
function claimNextJob() {
	const count = viewport.isPlaying ? WINDOW_AHEAD : PAUSED_AHEAD
	for (const frame of framesAhead(head(), count)) {
		for (const {layer, id} of lvLayersAt(frame)) {
			if (cache.has(id) || inProgress.has(id) || failed.has(id)) continue
			inProgress.add(id)
			return {frame, layer, id}
		}
	}
	return null
}

async function decode(job: {frame: number; layer: number; id: string}) {
	const [bw, bh] = backing.value
	// Regenerate the lv from the hi-res jpg if its file is missing.
	await project.ensureLv(job.frame, job.layer)
	const blob = await resolveBlob(job.id)
	if (!blob) return null
	return createImageBitmap(blob, {
		resizeWidth: bw,
		resizeHeight: bh,
		resizeQuality: 'medium',
	})
}

async function decodeWorker(gen: number) {
	while (gen === generation) {
		const job = claimNextJob()
		if (!job) {
			// Paused: the window is decoded, nothing left to do until it moves.
			if (!viewport.isPlaying) return
			// Playing: wait a beat and re-check as the playhead advances.
			await delay(16)
			continue
		}
		const at = epoch
		let bmp: ImageBitmap | null = null
		try {
			bmp = await decode(job)
		} catch {
			// A frame that fails to decode is skipped; playback repeats the prior one.
		} finally {
			inProgress.delete(job.id)
		}
		if (!bmp) {
			failed.add(job.id)
		} else if (at !== epoch) {
			bmp.close()
		} else {
			// Kept even when the window moved on meanwhile: the image is still
			// what this id shows, and the next prune drops it if it's unneeded.
			cache.get(job.id)?.close()
			cache.set(job.id, bmp)
			if (
				viewport.isPlaying &&
				lvLayersAt(viewport.previewFrame).some(l => l.id === job.id)
			) {
				draw()
			}
		}
	}
}

// (Re)start the workers on the current window. Decodes already in flight are
// left to finish — their results are still good.
function restart() {
	const gen = ++generation
	failed.clear()
	prune()
	const n = viewport.isPlaying ? CONCURRENCY : PAUSED_CONCURRENCY
	for (let i = 0; i < n; i++) decodeWorker(gen)
}

let pausedTimer: ReturnType<typeof setTimeout> | undefined

watch(
	() => viewport.isPlaying,
	playing => {
		clearTimeout(pausedTimer)
		restart()
		if (playing) draw()
	}
)

// While playing: redraw on each frame advance (and when the active layer
// changes) and slide the window along with the playhead. While paused: once
// the playhead has settled, decode the frames playback would start with.
watch(
	wanted,
	() => {
		if (viewport.isPlaying) {
			prune()
			return
		}
		clearTimeout(pausedTimer)
		pausedTimer = setTimeout(restart, PAUSED_DELAY)
	},
	{immediate: true}
)

watch(
	() => [viewport.previewFrame, viewport.currentLayer] as const,
	() => {
		if (viewport.isPlaying) draw()
	}
)

watch(backing, () => {
	clearCache()
	restart()
})

// Hold the start of playback until its first half second is decoded (the
// viewport store caps the wait). Normally that is already the case and this
// returns at once; it matters right after a jump.
async function preroll(startFrame: number) {
	const count = Math.min(WINDOW_AHEAD, Math.max(4, Math.ceil(project.fps / 2)))
	const ids = framesAhead(startFrame, count).flatMap(frame =>
		lvLayersAt(frame).map(l => l.id)
	)
	while (
		viewport.isPlaying &&
		ids.some(id => !cache.has(id) && !failed.has(id))
	) {
		await delay(8)
	}
}

onMounted(() => {
	viewport.setPlaybackPreroll(preroll)
	// The cast of the preview (stores/previewCast.ts) copies this canvas while
	// playing.
	cast.setPlaybackCanvas(canvas.value)
})

onUnmounted(() => {
	viewport.setPlaybackPreroll(null)
	cast.setPlaybackCanvas(null)
	clearTimeout(pausedTimer)
	generation++
	clearCache()
})
</script>

<template>
	<canvas
		ref="canvas"
		class="PreviewPlayback"
		:width="backing[0]"
		:height="backing[1]"
		:style="{transform: `scale(${project.viewport.zoom})`}"
	/>
</template>

<style scoped lang="stylus">
.PreviewPlayback
	position absolute
	inset 0
	width 100%
	height 100%
</style>
