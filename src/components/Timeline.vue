<script lang="ts" setup>
import {Bndr} from 'bndr-js'
import {scalar} from 'linearly'
import Tq from 'tweeq'
import {useBndr} from 'tweeq'
import {computed, ref} from 'vue'

import {MixBlendModeValues, useProjectStore} from '@/stores/project'
import {useViewportStore} from '@/stores/viewport'

import Koma from './Koma.vue'
import TimelineGraph from './TimelineGraph.vue'
import TimelineWaveform from './TimelineWaveform.vue'

const project = useProjectStore()
const viewport = useViewportStore()

const $frameMeasure = ref<null | HTMLElement>(null)

const komaWidth = computed(() => {
	return project.timeline.zoomFactor * 80
})

const visibleRegion = computed(() => {
	return {left: viewport.previewFrame * komaWidth.value, width: komaWidth.value}
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

const layers = computed(() => {
	const komaLayerCounts = project.komas.map((_, i) => project.layerCount(i))
	const layerCount = Math.max(...komaLayerCounts, project.captureShot.layer + 1)

	return Array(layerCount)
		.fill(0)
		.map((_, i) => project.layer(i))
})

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

const vizStyles = computed(() => {
	return {
		top: `calc(var(--header-height) + var(--header-margin-bottom) + var(--koma-height) * ${layers.value.length})`,
	}
})
</script>

<template>
	<div class="Timeline">
		<aside>
			<div v-for="(layer, i) in layers" :key="i" class="layer-control">
				<Tq.InputDropdown
					:modelValue="layer.mixBlendMode"
					:options="MixBlendModeValues"
					@update:modelValue="project.layers[i].mixBlendMode = $event"
				/>
				<Tq.InputNumber
					:modelValue="layer.opacity * 100"
					:min="0"
					:max="100"
					:precision="0"
					suffix="%"
					@update:modelValue="project.layers[i].opacity = $event / 100"
				/>
			</div>
		</aside>
		<Tq.Timeline
			:visibleRegion="visibleRegion"
			@zoomHorizontal="onZoomTimeline"
		>
			<div
				class="komas"
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
			<div class="viz" :style="vizStyles">
				<TimelineWaveform />
				<TimelineGraph />
			</div>
			<template #scrollbarRight>
				<Tq.InputNumber
					:modelValue="project.timeline.zoomFactor * 100"
					:min="10"
					:max="200"
					suffix="%"
					:barOrigin="100"
					:step="1"
					style="width: 7em"
					@update:modelValue="project.timeline.zoomFactor = $event / 100"
				/>
			</template>
		</Tq.Timeline>
	</div>
</template>

<style lang="stylus" scoped>

.Timeline
	display grid
	grid-template-columns 100px 1fr

	--koma-width 80px
	--koma-height 53px
	--header-height 14px
	--header-margin-bottom 6px

aside
	padding-top calc(var(--header-height) + var(--header-margin-bottom))

.layer-control
	--tq-input-height 20px
	height var(--koma-height)
	padding 0 9px
	display flex
	flex-direction column
	gap 4px
	justify-content center

.komas
	position relative
	display flex
	height 100%

.frameMeasure
	position absolute
	top 0
	width 100%
	height var(--header-height)
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
	margin-bottom var(--header-margin-bottom)

.viz
	position absolute
	bottom 0
	width 100%
	z-index -1
</style>
