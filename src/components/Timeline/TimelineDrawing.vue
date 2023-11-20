<script setup lang="ts">
import {pausableWatch, useElementSize} from '@vueuse/core'
import paper from 'paper'
import {onMounted, ref, watch, watchEffect} from 'vue'

import {useProjectStore} from '@/stores/project'
import {useTimelineStore} from '@/stores/timeline'

const $canvas = ref<null | HTMLCanvasElement>(null)

interface Props {
	scroll: number
}

const props = defineProps<Props>()

const project = useProjectStore()
const timeline = useTimelineStore()

const scope = ref<paper.PaperScope | null>(null)

const tools = ref<Record<string, paper.Tool>>({})

const {height: canvasHeight} = useElementSize($canvas)

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
					strokeColor: 'white',
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

		tools.value['pencil'] = pencil
	}

	// Eraser
	{
		const eraser = new paper.Tool()

		eraser.onMouseDrag = eraser.onMouseDown = (event: any) => {
			const lastPoint: paper.Point = event.lastPoint
			const delta: paper.Point = event.delta

			const divs = Math.floor(delta.length) + 2

			for (let i = 0; i < divs; i++) {
				const t = i / (divs - 1)
				const p = lastPoint.add(delta.multiply(t))

				const items = scope.value?.project.hitTestAll(p)
				items?.forEach(hit => hit.item.remove())
			}
		}

		eraser.onMouseUp = () => {
			saveDrawing()
		}

		tools.value['eraser'] = eraser
	}

	watchEffect(() => tools.value[timeline.currentTool]?.activate())
})

function saveDrawing() {
	savedDrawingWatcher.pause()
	const json = scope.value?.project.exportJSON()
	if (json) {
		project.timeline.drawing = json
	}
	savedDrawingWatcher.resume()
}

const savedDrawingWatcher = pausableWatch(
	() => [project.timeline.drawing, scope.value] as const,
	([drawing, scope]) => {
		if (!drawing || !scope) return

		scope.project.clear()
		scope.project.importJSON(drawing)
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
		<canvas ref="$canvas" class="canvas" resize />
	</div>
</template>

<style scoped lang="stylus">
.TimelineDrawing
	position absolute
	inset 0
	z-index 400
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
	inset 0
	width 100%
	height 100%
</style>
