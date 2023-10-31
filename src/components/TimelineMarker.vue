<script setup lang="ts">
import {Bndr} from 'bndr-js'
import {scalar} from 'linearly'
import {useBndr} from 'tweeq'
import {computed, ref} from 'vue'

import {useMarkersStore} from '@/stores/markers'
import {Marker} from '@/stores/project'
import {useTimelineStore} from '@/stores/timeline'

interface Props {
	index?: number
	marker: Marker
}

const props = withDefaults(defineProps<Props>(), {index: -1})

const markers = useMarkersStore()
const timeline = useTimelineStore()

const styles = computed(() => {
	const {frame, verticalPosition, color, duration} = props.marker

	return {
		left: `${frame * timeline.komaWidth}px`,
		top: `calc(${verticalPosition} * 100%)`,
		width: `calc(${duration} * var(--koma-width))`,
		color,
	}
})

function remove() {
	markers.remove(props.index)
}

const $marker = ref<null | HTMLElement>(null)

let startMarker: Marker | null = null
let dx = 0
let dragMarkerIndex = props.index

useBndr($marker, $marker => {
	Bndr.pointer($marker)
		.drag({pointerCapture: true})
		.on(d => {
			if (d.justStarted) {
				if (!d.event.metaKey) {
					markers.clearSelection()
				}
				markers.addSelection(props.index)
				dx = 0
				startMarker = {...props.marker}

				dragMarkerIndex = d.event.altKey
					? markers.add(startMarker)
					: props.index
			} else if (startMarker) {
				dx += d.delta[0] / timeline.komaWidth

				const {top, bottom} = $marker.parentElement!.getBoundingClientRect()

				const verticalPosition = scalar.clamp(
					scalar.invlerp(top, bottom, d.current[1]),
					0,
					1
				)

				const frame = startMarker.frame + Math.round(dx)

				markers.update(dragMarkerIndex, {
					...startMarker,
					verticalPosition,
					frame,
				})
			}
		})
})
</script>

<template>
	<div
		ref="$marker"
		class="TimelineMarker"
		:class="{
			single: marker.duration === 0,
			selected: markers.isSelected(props.index),
		}"
		:style="styles"
		@dblclick="remove"
	>
		<div class="label">{{ marker.label }}</div>
	</div>
</template>

<style lang="stylus" scoped>
@import '../../dev_modules/tweeq/src/common.styl'

.TimelineMarker
	position absolute
	height 1em
	min-width 1em
	line-height 1em
	border-radius 0.5em
	background currentColor

	&:hover
	&.selected
		outline 3px solid set-alpha(--tq-color-on-background, 0.5)

	.label
		width fit-content
		text-wrap nowrap
		pointer-events none
	&.single
		margin-left calc(-0.5 * 1em)

		&:before
			content ''
			display block
			position absolute
			top 0
			left 0
			width 1em
			height 1em
			background currentColor
			border-radius 0.5em


		.label
			padding-left calc(1em + 6px)
			z-index -1
			border-radius 0.5em
			background set-alpha(--tq-color-background, 0.5)

	&:not(.single)
		padding 0 0.25em
		overflow hidden
		.label
			font-weight bold
			color var(--tq-color-background)
</style>
