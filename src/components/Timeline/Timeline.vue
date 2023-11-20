<script lang="ts" setup>
import {clamp, range} from 'lodash'
import Tq from 'tweeq'
import {computed, onMounted, ref, watch} from 'vue'

import {MixBlendModeValues, useProjectStore} from '@/stores/project'
import {useSelectionStore} from '@/stores/selection'
import {useTimelineStore} from '@/stores/timeline'
import {useViewportStore} from '@/stores/viewport'

import TimelineDrawing from './TimelineDrawing.vue'
import TimelineGraph from './TimelineGraph.vue'
import TimelineHeader from './TimelineHeader.vue'
import TimelineKoma from './TimelineKoma.vue'
import TimelineMarkers from './TimelineMarkers.vue'
import TimelineWaveform from './TimelineWaveform.vue'

const project = useProjectStore()
const viewport = useViewportStore()
const timeline = useTimelineStore()
const appSelection = useSelectionStore()

const $timeline = ref<null | InstanceType<typeof Tq.Timeline>>(null)

onMounted(() => {
	watch(
		() => viewport.previewFrame,
		previewFrame => {
			const left = previewFrame * timeline.komaWidth
			const width = timeline.komaWidth

			$timeline.value?.showRegion({left, width})
		},
		{immediate: true}
	)
})

const scroll = ref(0)

const containerWidth = computed(() => {
	return $timeline.value?.containerWidth ?? 0
})

const visibleFrames = computed(() => {
	const start = Math.floor(scroll.value / timeline.komaWidth)
	const end = Math.ceil(
		(scroll.value + containerWidth.value) / timeline.komaWidth
	)

	return range(start, end + 1)
})

function onZoom({origin, zoomDelta}: {origin: number; zoomDelta: number}) {
	const oldZoomFactor = project.timeline.zoomFactor
	const newZoomFactor = clamp(project.timeline.zoomFactor * zoomDelta, 0.1, 2)
	project.timeline.zoomFactor = newZoomFactor

	const zoomFactorDelta = newZoomFactor / oldZoomFactor

	scroll.value = origin * zoomFactorDelta - (origin - scroll.value)
}

function onUpdateZoomFactor(zoomFactor: number) {
	const zoomFactorDelta = zoomFactor / project.timeline.zoomFactor
	project.timeline.zoomFactor = zoomFactor

	scroll.value *= zoomFactorDelta
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

const vizStyles = computed(() => {
	return {
		top: `calc(var(--header-height) + var(--header-margin-bottom) + var(--koma-height) * ${
			2 /*layers.value.length*/
		})`,
	}
})
</script>

<template>
	<div
		class="Timeline"
		:style="{
			'--koma-width': timeline.komaWidth + 'px',
			'--koma-height': timeline.komaHeight + 'px',
			'--duration': project.allKomas.length,
			'--in-point': project.previewRange[0],
			'--out-point': project.previewRange[1],
			'--onionskin': project.onionskin,
		}"
		@pointerdown="appSelection.reserveUnselect"
	>
		<aside class="aside">
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
		<Tq.Timeline ref="$timeline" v-model:scroll="scroll" @zoom="onZoom">
			<div class="seekbar header-text-style" :style="seekbarStyles">
				{{ viewport.previewFrame }}
				<div class="onionskin" :class="{pos: project.onionskin > 0}" />
			</div>
			<div
				class="content"
				:style="{
					width: project.allKomas.length * timeline.komaWidth + 'px',
				}"
			>
				<TimelineHeader />
				<div class="viz" :style="vizStyles">
					<TimelineWaveform />
					<TimelineGraph />
					<TimelineMarkers :komaWidth="timeline.komaWidth" />
				</div>
				<div class="komas">
					<TimelineKoma
						v-for="frame in visibleFrames"
						:key="frame"
						class="koma"
						:frame="frame"
						:style="{left: frame * timeline.komaWidth + 'px'}"
					/>
				</div>
			</div>
			<template #fixed>
				<TimelineDrawing :style="vizStyles" :scroll="scroll" />
			</template>
			<template #scrollbarRight>
				<Tq.InputNumber
					:modelValue="project.timeline.zoomFactor * 100"
					:min="10"
					:max="200"
					suffix="%"
					:barOrigin="100"
					:step="1"
					:precision="0"
					style="width: 7em"
					@update:modelValue="onUpdateZoomFactor($event / 100)"
					@dblclick="project.timeline.zoomFactor = 1"
				/>
			</template>
		</Tq.Timeline>
	</div>
</template>

<style lang="stylus" scoped>
.Timeline
	display grid
	grid-template-columns 100px 1fr
	--header-height 14px
	--header-margin-bottom 6px

.aside
	padding-top calc(var(--header-height) + var(--header-margin-bottom))

.layer-control
	--tq-input-height 20px
	height var(--koma-height)
	padding 0 9px
	display flex
	flex-direction column
	gap 4px
	justify-content center

.content
	position relative
	height 100%

.komas
	position relative
	width 100%
	z-index 100
	height 0

.koma
	position absolute
	pointer-events none

	& > :deep(*)
		pointer-events auto

:deep(.header-text-style)
	font-size 9px
	text-indent 0.4em
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

.onionskin
	position absolute
	top 0
	left calc(var(--koma-width) * var(--onionskin))
	right 100%
	height var(--header-height)
	background var(--md-sys-color-on-tertiary-container)
	opacity 0.5
	border-radius 99px 0 0 99px

	&.pos
		left var(--koma-width)
		right auto
		width calc(var(--koma-width) * var(--onionskin))
		border-radius 0 99px 99px 0

.viz
	position absolute
	bottom 0
	width 100%
</style>
