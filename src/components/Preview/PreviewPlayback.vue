<script setup lang="ts">
import {computed, onUnmounted, shallowRef, watch} from 'vue'

import {useProjectStore} from '@/stores/project'
import {useViewportStore} from '@/stores/viewport'

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

async function buildCache() {
	const gen = ++generation
	clearCache()

	const [bw, bh] = backing.value
	const [inPoint, outPoint] = project.previewRange
	const total = outPoint - inPoint + 1
	if (total <= 0) return

	// Decode starting from the current playhead so the frames about to play are
	// ready first, then wrap around to cover the rest of the range.
	const start = Math.min(Math.max(viewport.previewFrame, inPoint), outPoint)

	const jobs: {frame: number; layer: number; blob: Blob}[] = []
	for (let i = 0; i < total; i++) {
		const frame = inPoint + ((start - inPoint + i) % total)
		const shots = project.allKomas[frame]?.shots ?? []
		for (let layer = 0; layer < shots.length; layer++) {
			const blob = shots[layer]?.lv
			if (blob) jobs.push({frame, layer, blob})
		}
	}

	let next = 0
	const CONCURRENCY = 8

	async function worker() {
		while (next < jobs.length) {
			if (gen !== generation) return
			const {frame, layer, blob} = jobs[next++]
			try {
				const bmp = await createImageBitmap(blob, {
					resizeWidth: bw,
					resizeHeight: bh,
					resizeQuality: 'medium',
				})
				if (gen !== generation) {
					bmp.close()
					return
				}
				cache.set(key(frame, layer), bmp)
				if (frame === viewport.previewFrame) draw()
			} catch {
				// Skip frames that fail to decode; playback just repeats the prior one.
			}
		}
	}

	await Promise.all(
		Array(Math.min(CONCURRENCY, jobs.length))
			.fill(0)
			.map(worker)
	)
}

watch(
	() => viewport.isPlaying,
	playing => {
		if (playing) {
			buildCache()
			draw()
		} else {
			generation++ // cancel any in-flight build
			clearCache()
		}
	}
)

// Redraw on each frame advance (and when the active layer changes) while playing.
watch(
	() => [viewport.previewFrame, viewport.currentLayer] as const,
	() => {
		if (viewport.isPlaying) draw()
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
