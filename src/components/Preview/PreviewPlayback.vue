<script setup lang="ts">
import {computed, onUnmounted, shallowRef, watch} from 'vue'

import {useProjectStore} from '@/stores/project'
import {useViewportStore} from '@/stores/viewport'
import {resolveBlob} from '@/utils'

const project = useProjectStore()
const viewport = useViewportStore()

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
const cache = new Map<string, ImageBitmap>()
let generation = 0

const key = (frame: number, layer: number) => `${frame}:${layer}`

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
	for (const bmp of cache.values()) bmp.close()
	cache.clear()
}

function draw() {
	const c = canvas.value
	if (!c) return

	const ctx = c.getContext('2d')
	if (!ctx) return

	const frame = viewport.previewFrame
	const shots = project.allKomas[frame]?.shots ?? []
	const topLayer = Math.min(viewport.currentLayer, shots.length - 1)

	if (topLayer < 0) {
		// Empty frame (e.g. the capture frame): clear to the black frame bg.
		ctx.clearRect(0, 0, c.width, c.height)
		return
	}

	// Keep showing the previous frame until this one's base layer is decoded, so
	// a not-yet-cached frame repeats rather than flashing black.
	if (!cache.has(key(frame, 0))) return

	ctx.clearRect(0, 0, c.width, c.height)

	for (let layer = 0; layer <= topLayer; layer++) {
		const bmp = cache.get(key(frame, layer))
		if (!bmp) continue

		const {opacity, mixBlendMode} = project.layer(layer)
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
// and `prune()` drops frames once they've left the window.
const WINDOW_AHEAD = 32
const WINDOW_BEHIND = 8
const CONCURRENCY = 8

// "frame:layer" keys currently being decoded, so workers don't claim the same one.
const inProgress = new Set<string>()

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// The frames the player will run through next, in play order: inside the preview
// range it loops; outside it (before the in-point / past the out-point) it plays
// straight to the project end. Mirrors the viewport store.
function playRange() {
	const [inPoint, outPoint] = project.previewRange
	const head = viewport.previewFrame
	const outside = head < inPoint || head > outPoint
	return outside
		? {from: head, to: project.allKomas.length - 1, loop: false}
		: {from: inPoint, to: outPoint, loop: true}
}

function clampHead({from, to}: ReturnType<typeof playRange>) {
	return Math.min(Math.max(viewport.previewFrame, from), to)
}

// The set of frames to keep decoded: WINDOW_AHEAD ahead of the head (in play
// order, wrapping when looping) plus a few behind.
function windowFrames(range: ReturnType<typeof playRange>, head: number) {
	const {from, to, loop} = range
	const span = to - from + 1
	const keep = new Set<number>()

	let f = head
	for (let i = 0; i < WINDOW_AHEAD && i <= span; i++) {
		keep.add(f)
		if (++f > to) {
			if (!loop) break
			f = from
		}
	}

	f = head
	for (let i = 0; i < WINDOW_BEHIND && i <= span; i++) {
		if (--f < from) {
			if (!loop) break
			f = to
		}
		keep.add(f)
	}

	return keep
}

// Drop cached bitmaps that have fallen outside the window.
function prune() {
	const range = playRange()
	const keep = windowFrames(range, clampHead(range))
	for (const k of [...cache.keys()]) {
		const frame = Number(k.slice(0, k.indexOf(':')))
		if (!keep.has(frame)) {
			cache.get(k)?.close()
			cache.delete(k)
		}
	}
}

// The nearest frame:layer ahead of the playhead that still needs decoding; claims
// it via `inProgress` so concurrent workers don't duplicate work.
function claimNextJob() {
	const {from, to, loop} = playRange()
	const span = to - from + 1
	let f = Math.min(Math.max(viewport.previewFrame, from), to)

	for (let i = 0; i < WINDOW_AHEAD && i <= span; i++) {
		const shots = project.allKomas[f]?.shots ?? []
		for (let layer = 0; layer < shots.length; layer++) {
			const id = shots[layer]?.lv
			if (!id) continue
			const k = key(f, layer)
			if (cache.has(k) || inProgress.has(k)) continue
			inProgress.add(k)
			return {frame: f, layer, id, k}
		}
		if (++f > to) {
			if (!loop) break
			f = from
		}
	}
	return null
}

async function decodeWorker(gen: number) {
	const [bw, bh] = backing.value
	while (gen === generation && viewport.isPlaying) {
		const job = claimNextJob()
		if (!job) {
			// Window is full; wait a beat and re-check as the playhead advances.
			await delay(16)
			continue
		}
		try {
			const blob = await resolveBlob(job.id)
			if (blob && gen === generation) {
				const bmp = await createImageBitmap(blob, {
					resizeWidth: bw,
					resizeHeight: bh,
					resizeQuality: 'medium',
				})
				if (gen === generation) {
					cache.set(job.k, bmp)
					if (job.frame === viewport.previewFrame) draw()
				} else {
					bmp.close()
				}
			}
		} catch {
			// Skip frames that fail to decode; playback just repeats the prior one.
		} finally {
			inProgress.delete(job.k)
		}
	}
}

watch(
	() => viewport.isPlaying,
	playing => {
		if (playing) {
			const gen = ++generation
			clearCache()
			inProgress.clear()
			draw()
			for (let i = 0; i < CONCURRENCY; i++) decodeWorker(gen)
		} else {
			generation++ // stop workers / cancel in-flight decodes
			clearCache()
			inProgress.clear()
		}
	}
)

// Redraw on each frame advance (and when the active layer changes) while playing,
// and slide the decode window along with the playhead.
watch(
	() => [viewport.previewFrame, viewport.currentLayer] as const,
	() => {
		if (viewport.isPlaying) {
			prune()
			draw()
		}
	}
)

onUnmounted(() => {
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
