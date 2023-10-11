<script lang="ts" setup>
import {Bndr} from 'bndr-js'
import {scalar} from 'linearly'
import Tq from 'tweeq'
import {useBndr} from 'tweeq'
import {computed, ref} from 'vue'

import {useProjectStore} from '@/stores/project'
import {useViewportStore} from '@/stores/viewport'

import Koma from './Koma.vue'

const project = useProjectStore()
const viewport = useViewportStore()

const $frameMeasure = ref<null | HTMLElement>(null)

const komaWidth = computed(() => {
	return project.timeline.zoomFactor * 80
})

const visibleRegion = computed(() => {
	return {left: viewport.currentFrame * komaWidth.value, width: komaWidth.value}
})

useBndr($frameMeasure, el => {
	Bndr.pointer(el)
		.drag({pointerCapture: true, coordinate: 'offset'})
		.on(d => {
			const frame = Math.floor(d.current[0] / komaWidth.value)
			viewport.currentFrame = frame
			viewport.isPlaying = false
		})
})

function onZoomTimeline(factor: number) {
	const newZoomFactor = project.timeline.zoomFactor * factor
	project.timeline.zoomFactor = scalar.quantize(
		scalar.clamp(newZoomFactor, 0.25, 2),
		0.001
	)
}

//------------------------------------------------------------------------------
// Styles

const seekbarStyles = computed(() => {
	return {
		transform: `translateX(calc(${viewport.previewFrame} * var(--koma-width)))`,
	}
})

const previewRangeStyles = computed(() => {
	const [inPoint, outPoint] = project.previewRange
	return {
		transform: `translateX(calc(${inPoint} * var(--koma-width)))`,
		width: `calc(${outPoint - inPoint + 1} * var(--koma-width) + 1px)`,
	}
})
</script>

<template>
	<Tq.Timeline :visibleRegion="visibleRegion" @zoomHorizontal="onZoomTimeline">
		<div
			class="Timeline"
			:style="{
				'--koma-width': komaWidth + 'px',
				width: `calc(${project.allKomas.length} * var(--koma-width))`,
			}"
		>
			<div ref="$frameMeasure" class="frameMeasure" />
			<div class="seekbar" :style="seekbarStyles">
				{{ viewport.previewFrame }}
			</div>
			<div class="previewRange" :style="previewRangeStyles" />
			<div v-for="(_, frame) in project.allKomas" :key="frame" class="koma">
				<div class="koma-header tq-font-numeric">{{ frame }}</div>
				<Koma :frame="frame" />
			</div>
		</div>
		<template #scrollbarRight>
			<Tq.InputNumber
				:modelValue="project.timeline.zoomFactor * 100"
				:min="20"
				:max="200"
				suffix="%"
				:barOrigin="100"
				:step="1"
				style="width: 7em"
				@update:modelValue="project.timeline.zoomFactor = $event / 100"
			/>
		</template>
	</Tq.Timeline>
</template>

<style lang="stylus" scoped>
.Timeline
	position relative
	display flex
	height 100%
	overflow hidden

	--koma-width 80px
	--koma-height 53px
	--header-height 14px

.frameMeasure
	position absolute
	top 0
	width 100%
	height 24px
	background-image linear-gradient(to right, var(--tq-color-on-background) 1px, transparent 1px, transparent var(--koma-width))
	background-size var(--koma-width) 14px
	background-repeat repeat-x
	background-position 0 0

header-frame-text-style()
	font-size 9px
	text-indent .4em
	line-height var(--header-height)

.seekbar
	pointer-events none
	position absolute
	width 2px
	margin-left -1px
	z-index 10
	background var(--tq-color-primary)
	height 100%
	color var(--tq-color-on-primary)
	header-frame-text-style()

	&:before
		pointer-events none
		content ''
		display block
		position absolute
		left 1px
		height var(--header-height)
		width var(--koma-width)
		background var(--tq-color-primary)
		z-index -1
		border-radius 0 999px 0 0

.previewRange
	position absolute
	height var(--header-height)
	background linear-gradient(to right,  var(--md-sys-color-secondary) 2px, transparent 2px, transparent calc(100% - 2px),  var(--md-sys-color-secondary) calc(100% - 2px))
	pointer-events none

	&:before
		content ''
		display block
		position relative
		width 100%
		height 100%
		top 0
		left 0
		background var(--md-sys-color-secondary)
		opacity .2

.koma-header
	header-frame-text-style()
	width var(--koma-width)
	height var(--header-height)
	border-left 1px solid var(--tq-color-on-background)
	margin-bottom 6px
</style>
