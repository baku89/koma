<script setup lang="ts">
import {vec2} from 'linearly'
import {toPercent} from 'tweeq'
import {computed} from 'vue'

import {Marker} from '@/stores/project'

interface Props {
	marker: Marker
	selected: boolean
	rangeStyle: (range: vec2) => any
}

const props = defineProps<Props>()

const styles = computed(() => {
	const {frame, verticalPosition, color, duration} = props.marker

	return {
		top: toPercent(verticalPosition),
		color,
		...props.rangeStyle([frame, frame + duration - 1]),
	}
})
</script>

<template>
	<div
		ref="$marker"
		class="TimelineMarker"
		:class="{
			selected,
			'zero-duration': marker.duration === 0,
		}"
		:style="styles"
	>
		<div class="label">{{ marker.label }}</div>
		<div class="duration-handle" />
	</div>
</template>

<style lang="stylus" scoped>
@import '../../../dev_modules/tweeq/src/common.styl'

.TimelineMarker
	position absolute
	height 1em
	line-height 1em
	border-radius 0.5em

	&:before
		content ''
		display block
		position absolute
		inset 0
		border-radius 0.5em

	&:hover
	&.selected
		&:before
			outline 3px solid set-alpha(--tq-color-selection, 0.5)

	.label
		width fit-content
		text-wrap nowrap
		pointer-events none

	.duration-handle
		position absolute
		top 0
		right -1em
		width 1em
		height 1em
		z-index 1000
		cursor ew-resize

	&.zero-duration
		margin-left calc(-0.5 * 1em)

		&:before
			width 1em
			height 1em
			background currentColor

		.label
			padding-left calc(1em + 6px)
			z-index -1
			border-radius 0.5em
			background set-alpha(--tq-color-background, 0.5)

	&:not(.zero-duration)
		background currentColor
		padding 0 0.25em
		.label
			font-weight bold
			color var(--tq-color-background)
</style>
