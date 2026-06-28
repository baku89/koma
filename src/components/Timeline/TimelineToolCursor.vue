<script setup lang="ts">
import {useEventListener} from '@vueuse/core'
import {vec2} from 'linearly'
import {computed, ref} from 'vue'

import {useTimelineStore} from '@/stores/timeline'

const props = defineProps<{
	range: vec2
}>()

const timeline = useTimelineStore()

const $root = ref<HTMLElement | null>(null)

// Horizontal offset (px from the content origin) of the cursor bar, or null when
// the pointer is outside the timeline / the tool doesn't use a cursor.
const cursorX = ref<number | null>(null)

const active = computed(
	() =>
		timeline.currentTool === 'marker' || timeline.currentTool === 'pencil'
)

useEventListener(window, 'pointermove', (e: PointerEvent) => {
	if (!active.value || !$root.value) {
		cursorX.value = null
		return
	}

	const rect = $root.value.getBoundingClientRect()
	const x = e.clientX - rect.left
	const y = e.clientY - rect.top

	if (x < 0 || x > rect.width || y < 0 || y > rect.height) {
		cursorX.value = null
		return
	}

	if (timeline.currentTool === 'marker') {
		// Markers are discretized per frame — snap the bar to the frame the marker
		// would land on, so it jumps in frame-width steps.
		const frame = Math.round(x / timeline.frameWidth + props.range[0])
		cursorX.value = (frame - props.range[0]) * timeline.frameWidth
	} else {
		// Pencil draws freely, so the bar tracks the raw cursor position.
		cursorX.value = x
	}
})

const barStyle = computed(() => ({
	transform: `translateX(${cursorX.value}px)`,
}))
</script>

<template>
	<div ref="$root" class="TimelineToolCursor">
		<div
			v-if="active && cursorX !== null"
			class="bar"
			:class="timeline.currentTool"
			:style="barStyle"
		/>
	</div>
</template>

<style scoped lang="stylus">
@import '../../../dev_modules/tweeq/src/common.styl'

.TimelineToolCursor
	position absolute
	inset 0
	pointer-events none
	overflow hidden
	z-index 2

.bar
	position absolute
	top 0
	height 100%
	width 1px
	margin-left -0.5px
	background set-alpha(--tq-color-text, 0.5)
</style>
