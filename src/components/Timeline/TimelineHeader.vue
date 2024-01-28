<script setup lang="ts">
import * as Bndr from 'bndr-js'
import {useBndr} from 'tweeq'
import {computed, ref} from 'vue'

import {useProjectStore} from '@/stores/project'
import {useTimelineStore} from '@/stores/timeline'
import {useViewportStore} from '@/stores/viewport'

const project = useProjectStore()
const timeline = useTimelineStore()
const viewport = useViewportStore()

const $frameMeasure = ref<null | HTMLElement>(null)

useBndr($frameMeasure, el => {
	Bndr.pointer(el)
		.drag({pointerCapture: true, coordinate: 'offset'})
		.on(d => {
			const frame = Math.floor(d.current[0] / timeline.komaWidth)
			viewport.setCurrentFrame(frame)
			viewport.isPlaying = false
		})
})

const previewRangeStyles = computed(() => {
	const [inPoint, outPoint] = project.previewRange

	const {komaWidth} = timeline
	const duration = outPoint - inPoint + 1

	return {
		transform: `translateX(${inPoint * komaWidth}px)`,
		width: `${duration * komaWidth}px`,
	}
})

const measures = computed(() => {
	const {komaWidth} = timeline

	if (komaWidth < 15) {
		const fps = project.fps
		return project.allKomas
			.filter((_, i) => i % fps === 0)
			.map((_, i) => ({
				left: i * fps * komaWidth + 'px',
				text: i + 's',
			}))
	} else {
		return project.allKomas.map((_, i) => ({
			left: i * komaWidth + 'px',
			text: i,
		}))
	}
})
</script>

<template>
	<div ref="$frameMeasure" class="TimelineHeader">
		<div
			v-for="{left, text} in measures"
			:key="text"
			class="header tq-font-numeric header-text-style"
			:style="{left}"
		>
			{{ text }}
		</div>
		<div class="preview-range" :style="previewRangeStyles" />
	</div>
</template>

<style scoped lang="stylus">
.TimelineHeader
	position relative
	width 100%
	height var(--header-height)

	background-image linear-gradient(to right, var(--tq-color-surface-border) 1px, transparent 1px)
	background-size var(--koma-width) 100%

.header
	height var(--header-height)
	border-left 1px solid var(--tq-color-on-background)
	margin-bottom var(--header-margin-bottom)
	position absolute

.preview-range
	position absolute
	height var(--header-height)
	background var(--md-sys-color-secondary)
	opacity 0.2
</style>
