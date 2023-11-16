<script setup lang="ts">
import {Bndr} from 'bndr-js'
import {scalar} from 'linearly'
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

useBndr($root, $root => {
	Bndr.pointer($root)
		.drag({
			pointerCapture: true,
			selector: '.TimelineMarker',
		})
		.on(d => {
			if (d.justStarted) {
				markersToDrag.clear()
				markers.selectedIndices.forEach(i => {
					markersToDrag.set(i, {...project.markers[i]})
				})
			} else {
				const deltaFrame = Math.round(
					(d.current[0] - d.start[0]) / timeline.komaWidth
				)
				const height = $root.getBoundingClientRect().height
				const deltaVerticalPosition = (d.current[1] - d.start[1]) / height

				project.$patch(draft => {
					markersToDrag.forEach((m, i) => {
						draft.markers[i].frame = clamp(
							m.frame + deltaFrame,
							0,
							project.duration - 1
						)
						draft.markers[i].verticalPosition = clamp(
							m.verticalPosition + deltaVerticalPosition,
							0,
							1
						)
					})
				})
			}
		})
})
</script>

<template>
	<div ref="$root" class="TimelineMarkers">
		<TimelineMarker
			v-if="canAddmarker"
			class="cursor"
			:marker="markers.cursor"
		/>
		<TimelineMarker
			v-for="(marker, i) in project.markers ?? []"
			:key="i"
			:index="i"
			:marker="marker"
			:selected="markers.isSelected(i)"
			@pointerdown="select($event, i)"
		/>
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
</style>
