<script setup lang="ts">
import {pausableWatch, useElementBounding} from '@vueuse/core'
import paper from 'paper'
import {onMounted, shallowReactive, shallowRef, watch, watchEffect} from 'vue'

import {useProjectStore} from '@/stores/project'
import {useTimelineStore} from '@/stores/timeline'

const $canvas = shallowRef<null | HTMLCanvasElement>(null)

interface Props {
	scroll: number
}

const props = defineProps<Props>()

const project = useProjectStore()
const timeline = useTimelineStore()

const scope = shallowRef<paper.PaperScope | null>(null)

const tools = shallowReactive<Record<string, paper.Tool>>({})

const {height: canvasHeight, width: canvasWidth} = useElementBounding($canvas)

onMounted(() => {
	const canvas = $canvas.value!
	scope.value = paper.setup(canvas) as unknown as paper.PaperScope

	// Pencil
	{
		let path: paper.Path | null = null

		const pencil = new paper.Tool()
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

		pencil.onMouseUp = () => {
			path = null
			saveDrawing()
		}

		tools['pencil'] = pencil
	}

	// Eraser
	{
		const eraser = new paper.Tool()

		eraser.onMouseDrag = eraser.onMouseDown = (event: paper.ToolEvent) => {
			if (event.type !== 'mousedrag') return

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
		}

		tools['eraser'] = eraser
	}

	watchEffect(() => tools[timeline.currentTool]?.activate())
})

function saveDrawing() {
	savedDrawingWatcher.pause()
	const json = scope.value?.project.exportJSON({asString: false})
	if (json) {
		project.timeline.drawing = json
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
			props.scroll,
			project.timeline.zoomFactor,
			canvasHeight.value,
		] as const,
	([scope, scroll, zoom, height]) => {
		if (!scope) return

		const vertZoom = height / 400
		const matrix = new paper.Matrix(zoom, 0, 0, vertZoom, -scroll, 0)
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

	&.pencil
		cursor crosshair

	&.eraser
		cursor pointer

.canvas
	position absolute
	inset 0
	width 100%
	height 100%
</style>
