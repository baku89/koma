<script setup lang="ts">
import {Bndr} from 'bndr-js'
import {scalar, vec2} from 'linearly'
import {clamp} from 'lodash'
import {useBndr} from 'tweeq'
import {computed, ref, watch} from 'vue'

import {useMarkersStore} from '@/stores/markers'
import {Marker} from '@/stores/project'
import {useProjectStore} from '@/stores/project'
import {useSelectionStore} from '@/stores/selection'
import {useTimelineStore} from '@/stores/timeline'
import {speak} from '@/utils'

import TimelineMarker from './TimelineMarker.vue'

interface Props {
	komaWidth: number
}

const props = defineProps<Props>()

const project = useProjectStore()
const markers = useMarkersStore()
const timeline = useTimelineStore()
const appSelection = useSelectionStore()

const $root = ref<null | HTMLElement>(null)

const cursorVisible = ref(false)

const canAddmarker = computed(() => {
	return cursorVisible.value && timeline.currentTool === 'marker'
})

// Speak marker labels on change the capture frame
watch(
	() => project.captureShot,
	({frame}) => {
		project.markers
			.filter(
				m => m.frame <= frame && frame < m.frame + Math.max(1, m.duration)
			)
			.sort((a, b) => a.verticalPosition - b.verticalPosition)
			.forEach(m => speak(m.label))
	},
	{deep: true}
)

// Select and drag
function select(event: PointerEvent, index: number) {
	if (!event.shiftKey && markers.isSelected(index) === false) {
		appSelection.unselect()
	}
	markers.addSelection(index)
}

const markersToDrag: Map<number, Marker> = new Map()

const selectionRect = ref<null | {
	left: string
	top: string
	width: string
	height: string
}>(null)

useBndr($root, $root => {
	const pointer = Bndr.pointer($root)

	pointer.position({coordinate: 'offset'}).on(([x, y]) => {
		const frame = Math.floor(x / props.komaWidth)
		const verticalPosition = scalar.clamp(y / $root.clientHeight, 0, 1)

		markers.cursor = {...markers.cursor, frame, verticalPosition}
	})

	pointer.primary.down().on(() => {
		if (!canAddmarker.value) return

		markers.add()
	})

	pointer.on(e => {
		if (
			e.target !== $root ||
			e.type === 'pointerleave' ||
			e.type === 'pointercancel'
		) {
			cursorVisible.value = false
		} else {
			cursorVisible.value = true
		}
	})

	pointer
		.drag({
			pointerCapture: true,
			selector: '.TimelineMarkers',
			coordinate: 'offset',
		})
		.on(d => {
			if (canAddmarker.value) return

			const $rootRect = $root.getBoundingClientRect()

			let [xLower, xUpper] =
				d.start[0] < d.current[0]
					? [d.start[0], d.current[0]]
					: [d.current[0], d.start[0]]

			xLower = clamp(xLower, 0, $rootRect.width)
			xUpper = clamp(xUpper, 0, $rootRect.width)

			let [yLower, yUpper] =
				d.start[1] < d.current[1]
					? [d.start[1], d.current[1]]
					: [d.current[1], d.start[1]]

			yLower = clamp(yLower, 0, $rootRect.height)
			yUpper = clamp(yUpper, 0, $rootRect.height)

			const frameLower = Math.ceil(xLower / props.komaWidth)
			const frameUpper = Math.floor(xUpper / props.komaWidth)

			const verticalPositionLower = yLower / $root.clientHeight
			const verticalPositionUpper = yUpper / $root.clientHeight

			selectionRect.value = {
				left: xLower + 'px',
				width: xUpper - xLower + 'px',
				top: yLower + 'px',
				height: yUpper - yLower + 'px',
			}

			const indices: number[] = []

			project.markers.forEach((m, i) => {
				if (
					frameLower <= m.frame + m.duration &&
					m.frame <= frameUpper &&
					verticalPositionLower <= m.verticalPosition &&
					m.verticalPosition <= verticalPositionUpper
				) {
					indices.push(i)
				}
			})

			appSelection.unselect()
			markers.addSelection(...indices)
		})

	pointer
		.drag({
			pointerCapture: true,
			selector: '.TimelineMarker, .duration-handle',
		})
		.on(d => {
			if (d.type === 'down') {
				markersToDrag.clear()
				markers.selectedIndices.forEach(i => {
					markersToDrag.set(i, {...project.markers[i]})
				})
			} else {
				const offset = vec2.sub(d.current, d.start)

				const deltaFrame = Math.round(offset[0] / timeline.komaWidth)

				const height = $root.getBoundingClientRect().height
				const deltaVerticalPosition = offset[1] / height

				const isDraggingDurationHandle = (
					d.event.target as HTMLElement
				).matches('.duration-handle')

				if (isDraggingDurationHandle) {
					project.$patch(draft => {
						markersToDrag.forEach((m, i) => {
							const d = m.duration + deltaFrame
							draft.markers[i].duration = Math.max(d, 0)
						})
					})
				} else {
					project.$patch(draft => {
						markersToDrag.forEach((m, i) => {
							const f = m.frame + deltaFrame
							draft.markers[i].frame = clamp(f, 0, project.duration - 1)

							const vp = m.verticalPosition + deltaVerticalPosition
							draft.markers[i].verticalPosition = clamp(vp, 0, 1)
						})
					})
				}
			}
		})

	pointer.up().on(() => {
		selectionRect.value = null
	})
})
</script>

<template>
	<div ref="$root" class="TimelineMarkers">
		<TimelineMarker
			v-if="canAddmarker"
			class="cursor"
			:marker="markers.cursor"
			:selected="false"
		/>
		<TimelineMarker
			v-for="(marker, i) in project.markers ?? []"
			:key="i"
			:index="i"
			:marker="marker"
			:selected="markers.isSelected(i)"
			@pointerdown="select($event, i)"
		/>
		<div v-if="selectionRect" class="selection-rect" :style="selectionRect" />
	</div>
</template>

<style lang="stylus" scoped>
.TimelineMarkers
	position absolute
	inset 0
	z-index 100

.cursor
	opacity 0.5
	pointer-events none

.selection-rect
	position absolute
	z-index 100
	border 2px solid var(--tq-color-primary)
	border-radius var(--tq-input-border-radius)
</style>
