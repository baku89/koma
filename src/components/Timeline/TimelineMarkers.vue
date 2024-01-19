<script setup lang="ts">
import {BBox} from '@baku89/pave'
import {Bndr} from 'bndr-js'
import {scalar, vec2} from 'linearly'
import {clamp, range} from 'lodash'
import {useBndr} from 'tweeq'
import {computed, ref, watch} from 'vue'

import {useMarkersStore} from '@/stores/markers'
import {Marker} from '@/stores/project'
import {useProjectStore} from '@/stores/project'
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

const $root = ref<null | HTMLElement>(null)

const cursorVisible = ref(false)

const canAddMarker = computed(() => {
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

let alreadySelectedIndices: number[] = []

// Select and drag
function onPressMarker(event: PointerEvent, index: number) {
	if (!event.metaKey && markers.isSelected(index) === false) {
		markers.unselect()
	}
	markers.select(index)
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

		timeline.toolOptions = {...timeline.toolOptions, frame, verticalPosition}
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

	let drawingMarkerIndex: number | null = null

	pointer
		.drag({
			pointerCapture: true,
			selector: '.TimelineMarkers',
			coordinate: 'offset',
		})
		.on(d => {
			if (canAddMarker.value) {
				cursorVisible.value = false

				if (d.type === 'down') {
					drawingMarkerIndex = project.markers.push(timeline.toolOptions) - 1
				} else if (d.type === 'drag') {
					const duration = Math.max(
						0,
						timeline.toolOptions.frame -
							project.markers[drawingMarkerIndex!].frame
					)

					project.$patch(draft => {
						draft.markers[drawingMarkerIndex!].duration = duration
					})
				}

				return
			}

			if (d.type === 'down') {
				if (d.event.shiftKey) {
					alreadySelectedIndices = [...markers.selectedIndices]
				} else {
					alreadySelectedIndices = []
				}
			}

			const rootRect: BBox = [
				[0, 0],
				BBox.fromDOMRect($root.getBoundingClientRect())[1],
			]

			const dragRect = BBox.fromPoints(d.start, d.current)

			const [[xLower, yLower], [xUpper, yUpper]] = BBox.intersect(
				rootRect,
				dragRect
			)

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

			markers.unselect()
			markers.select(...alreadySelectedIndices, ...indices)
		})

	pointer
		.drag({
			pointerCapture: true,
			selector: '.TimelineMarker, .duration-handle',
		})
		.on(d => {
			if (d.type === 'down') {
				markersToDrag.clear()

				if (d.event.altKey) {
					const newMarkers = [...markers.selectedIndices].map(i => ({
						...project.markers[i],
					}))
					const start = project.markers.length
					const end = project.markers.push(...newMarkers)
					markers.unselect()
					markers.select(...range(start, end))
				}
				markers.selectedIndices.forEach(i => {
					markersToDrag.set(i, {...project.markers[i]})
				})
			} else if (d.type === 'drag') {
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
			v-if="canAddMarker"
			class="cursor"
			:marker="timeline.toolOptions"
			:selected="false"
		/>
		<TimelineMarker
			v-for="(marker, i) in project.markers ?? []"
			:key="i"
			:index="i"
			:marker="marker"
			:selected="markers.isSelected(i)"
			@pointerdown="onPressMarker($event, i)"
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
</style>
