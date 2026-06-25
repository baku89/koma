<script setup lang="ts">
import {pausableWatch, useElementBounding} from '@vueuse/core'
import {vec2} from 'linearly'
import paper from 'paper'
import {
	markRaw,
	nextTick,
	onMounted,
	onUnmounted,
	shallowReactive,
	shallowRef,
	watch,
	watchEffect,
} from 'vue'

import {useProjectStore} from '@/stores/project'
import {useTimelineStore} from '@/stores/timeline'

const $canvas = shallowRef<null | HTMLCanvasElement>(null)

const props = defineProps<{
	range: vec2
}>()

const project = useProjectStore()
const timeline = useTimelineStore()

const scope = shallowRef<paper.PaperScope | null>(null)
const tools = shallowReactive<Record<string, paper.Tool>>({})
const {height: canvasHeight, width: canvasWidth} = useElementBounding($canvas)

onMounted(() => {
	const canvas = $canvas.value!
	scope.value = paper.setup(canvas) as unknown as paper.PaperScope

	// TEMP: measure Paper's full-scene repaint. Paper repaints the entire
	// project (every path) on each frame a change occurs, so this is the cost
	// paid per frame while dragging a new stroke over an existing drawing.
	{
		const view = scope.value.view
		const orig = view.update.bind(view)
		;(view as unknown as {update: () => boolean}).update = () => {
			const t = performance.now()
			const r = orig()
			const d = performance.now() - t
			if (d > 20) {
				// eslint-disable-next-line no-console
				console.log(`[view.update] ${d.toFixed(0)}ms`)
			}
			return r
		}
	}

	// Pencil
	{
		let path: paper.Path | null = null

		const pencil = new paper.Tool()

		// Only fire onMouseDrag once the pointer has moved this far (project
		// units). Without it Paper appends a segment on every pointermove, so a
		// fast stroke allocates hundreds of segments — the allocation churn
		// triggers GC pauses that drop input and leave long straight gaps. Tune
		// up for lighter strokes, down for finer detail.
		pencil.minDistance = 4

		pencil.onMouseDown = () => {
			project.beginInteraction()
		}

		pencil.onMouseDrag = function (event: any) {
			if (!path) {
				path = new paper.Path({
					strokeColor: timeline.toolOptions.color,
					strokeWidth: 2,
					joinCap: 'round',
					lineCap: 'round',
					strokeScaling: false,
				})
			}
			path.lineTo(event.point)
		}

		pencil.onMouseUp = async () => {
			path = null
			// TEMP: measure the full mouseUp cost incl. flushed watchers.
			// useRefHistory deep-clones {komas, markers, drawing} on this change.
			const t = performance.now()
			saveDrawing()
			await nextTick()
			// eslint-disable-next-line no-console
			console.log(
				`[mouseUp] saveDrawing+flush ${(performance.now() - t).toFixed(0)}ms`
			)
			project.endInteraction()
		}

		tools['pencil'] = pencil
	}

	// Eraser
	{
		const eraser = new paper.Tool()

		// Throttle the (expensive) per-event hit test below to once per this much
		// pointer movement.
		eraser.minDistance = 4

		eraser.onMouseDown = () => {
			project.beginInteraction()
		}

		eraser.onMouseDrag = (event: paper.ToolEvent) => {
			const lastPoint: paper.Point = event.lastPoint
			const currentPoint: paper.Point = event.point

			const rect = new paper.Rectangle(lastPoint, currentPoint)
			const line = new paper.Path.Line(lastPoint, currentPoint)

			const candidates = scope.value?.project.getItems({
				class: paper.Path,
				overlapping: rect,
			})

			for (const item of candidates ?? []) {
				if (item.intersects(line)) {
					item.remove()
				}
			}
		}

		eraser.onMouseUp = () => {
			saveDrawing()
			project.endInteraction()
		}

		tools['eraser'] = eraser
	}

	watchEffect(() => tools[timeline.currentTool]?.activate())
})

// --- TEMP: long-task profiler (remove once the drawing jank is diagnosed) ---
// Logs every main-thread task >50ms with the gap since the previous one, so a
// periodic stall shows up in the console as e.g.
//   [longtask] 180ms (Δ 1002ms)   ← ~1s cadence → timer.ts
//   [longtask] 140ms (Δ 2003ms)   ← ~2s cadence → osc.ts reconnect
//   [longtask]  90ms (Δ 110ms)    ← irregular & dense → GC / Paper redraw
// Draw a few continuous strokes and read the cadence + attribution.
onMounted(() => {
	if (typeof PerformanceObserver === 'undefined') return

	let last = performance.now()
	const obs = new PerformanceObserver(list => {
		for (const entry of list.getEntries()) {
			const gap = entry.startTime - last
			last = entry.startTime
			// eslint-disable-next-line no-console
			console.log(
				`[longtask] ${entry.duration.toFixed(0)}ms (Δ ${gap.toFixed(0)}ms)`,
				(entry as PerformanceEntry & {attribution?: unknown}).attribution
			)
		}
	})

	try {
		obs.observe({entryTypes: ['longtask']})
	} catch {
		// 'longtask' unsupported in this engine — nothing to profile.
	}

	onUnmounted(() => obs.disconnect())
})

function saveDrawing() {
	savedDrawingWatcher.pause()
	const json = scope.value?.project.exportJSON({asString: false})
	if (json) {
		// markRaw so Vue doesn't deep-proxy the (large, growing) exported path
		// array. Without this, every stroke re-proxies the whole drawing tree
		// and forces the deep autosave/history watchers to walk it — cost grows
		// with how much has already been drawn.
		// exportJSON({asString: false}) returns an array at runtime, but paper's
		// types declare `string`, so cast for markRaw (which requires an object).
		project.timeline.drawing = markRaw(json as unknown as object)
	}
	savedDrawingWatcher.resume()
}

const savedDrawingWatcher = pausableWatch(
	() => [project.timeline.drawing, scope.value] as const,
	([drawing, scope]) => {
		if (!scope) return

		scope.project.clear()
		if (drawing) {
			scope.project.importJSON(drawing)
		}
		scope.project.view.update()
	},
	{immediate: true}
)

// Update canvas size
watch(
	[canvasWidth, canvasHeight],
	([width, height]) => {
		scope.value?.view.viewSize.set(width, height)
	},
	{immediate: true}
)

watch(
	() =>
		[
			scope.value,
			props.range,
			canvasHeight.value,
			timeline.frameWidth,
			timeline.frameWidthBase,
		] as const,
	([scope, [start], height]) => {
		if (!scope) return

		// Use the DOM timeline's pixels-per-frame as the single source of
		// truth so the drawing scrolls and scales exactly like the
		// DOM-positioned elements (komas, graph, markers). Deriving it from
		// the measured canvas width instead caused a horizontal mismatch:
		// paper.js overrides the canvas CSS width with an inline pixel value
		// on HiDPI displays, so canvasWidth could drift from the DOM frame
		// area and make the drawing scroll faster than the DOM.
		const frameWidth = timeline.frameWidth

		const vertZoom = height / 400
		const matrix = new paper.Matrix(
			frameWidth / timeline.frameWidthBase,
			0,
			0,
			vertZoom,
			-start * frameWidth,
			0
		)
		scope.view.matrix = matrix
	}
)
</script>

<template>
	<div class="TimelineDrawing" :class="[timeline.currentTool]">
		<canvas ref="$canvas" class="canvas" />
	</div>
</template>

<style scoped lang="stylus">
.TimelineDrawing
	position absolute
	inset 0
	pointer-events none

	&.pencil
	&.eraser
		pointer-events auto

	&.pencil
		cursor crosshair

	&.eraser
		cursor pointer

.canvas
	position absolute
	width 100%
	height 100%
</style>
