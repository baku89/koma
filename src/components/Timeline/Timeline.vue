<script lang="ts" setup>
import {vec2} from 'linearly'
import {range as _range} from 'lodash-es'
import * as Tq from 'tweeq'
import {computed, ref, watch} from 'vue'

import {MixBlendModeValues, useProjectStore} from '@/stores/project'
import {useSelectionStore} from '@/stores/selection'
import {useTimelineStore} from '@/stores/timeline'
import {useViewportStore} from '@/stores/viewport'

import Waveform from '../Waveform.vue'
import TimelineDrawing from './TimelineDrawing.vue'
import TimelineGraph from './TimelineGraph.vue'
import TimelineKoma from './TimelineKoma.vue'
import TimelineMarkers from './TimelineMarkers.vue'

const project = useProjectStore()
const viewport = useViewportStore()
const timeline = useTimelineStore()
const appSelection = useSelectionStore()

const $timeline = ref<null | InstanceType<typeof Tq.Timeline>>(null)

watch(
	() => viewport.previewFrame,
	previewFrame => {
		$timeline.value?.showRange(previewFrame)
	},
	{immediate: true}
)

function onDragRuler(value: number) {
	const frame = Math.floor(value)
	viewport.setCurrentFrame(frame)
	viewport.isPlaying = false
}

const layers = computed(() => {
	const komaLayerCounts = project.komas.map((_, i) => project.layerCount(i))
	const layerCount = Math.max(...komaLayerCounts, project.captureShot.layer + 1)

	return Array(layerCount)
		.fill(0)
		.map((_, i) => project.layer(i))
})

function toScales(range: vec2, unitWidth: number) {
	const start = Math.ceil(range[0])
	const end = Math.floor(range[1])

	if (unitWidth > 20) {
		return _range(start, end + 1).map((value: number) => ({
			value,
			label: value.toString(),
		}))
	} else {
		const fps = project.fps
		return _range(start, end)
			.filter((f: number) => f % fps === 0)
			.map((value: number) => ({value, label: value / fps + 's'}))
	}
}

//------------------------------------------------------------------------------
// Styles

/**
 * コマサムネイル分上にマージンを設けたスタイル。各種ビジュアライザーの表示位置調整に利用。
 */
const visualizersStyles = computed(() => {
	return {
		top: 'calc(var(--header-height) + var(--header-margin-bottom) + var(--layer-height))',
	}
})
</script>

<template>
	<div
		class="Timeline"
		:style="{
			'--frame-width': timeline.frameWidth + 'px',
			'--layer-height': timeline.layerHeight + 'px',
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
		<Tq.Timeline
			ref="$timeline"
			:frameRange="[0, project.duration]"
			v-model:frameWidth="timeline.frameWidth"
			:frameWidthRange="[10, timeline.frameWidthBase]"
			v-slot="{range, visibleFrameRange, rangeStyle, offsetStyle}"
		>
			<div
				class="seekbar header-text-style"
				:style="offsetStyle(viewport.previewFrame)"
			>
				{{ viewport.previewFrame }}
				<div class="onionskin" :class="{pos: project.onionskin > 0}" />
			</div>

			<Tq.Ruler
				class="ruler"
				:range="range"
				:scales="toScales(visibleFrameRange, timeline.frameWidth)"
				@drag="onDragRuler"
			>
				<div class="preview-range" :style="rangeStyle(project.previewRange)" />
			</Tq.Ruler>

			<div class="komas">
				<TimelineKoma
					v-for="frame in _range(...visibleFrameRange)"
					:key="frame"
					class="koma"
					:frame="frame"
					:style="rangeStyle(frame)"
				/>
			</div>

			<div class="visualizers" :style="visualizersStyles">
				<Waveform
					:src="project.audio.src"
					:range="[range[0] / project.fps, range[1] / project.fps]"
				/>
				<TimelineGraph :style="rangeStyle(project.previewRange)" />
				<TimelineDrawing class="drawing" :range="range" />
				<TimelineMarkers :range="range" :rangeStyle="rangeStyle" />
			</div>
		</Tq.Timeline>
	</div>
</template>

<style lang="stylus" scoped>
@import '../../../dev_modules/tweeq/src/common.styl'

.Timeline
	display grid
	grid-template-columns 100px 1fr
	--header-height 14px
	--header-margin-bottom 6px

.aside
	padding-top calc(var(--header-height) + var(--header-margin-bottom))

.layer-control
	--tq-input-height 20px
	height var(--layer-height)
	padding 0 9px
	display flex
	flex-direction column
	gap 4px
	justify-content center


.ruler
	height var(--header-height)
	margin-bottom var(--header-margin-bottom)

.preview-range
	height 100%
	background set-alpha(--tq-color-text, 0.2)
	position relative

	&:before
	&:after
		content ''
		display block
		position absolute
		top 0
		width 6px
		height 100%
		border 1px solid var(--tq-color-text)

	&:before
		left 0
		border-right none

	&:after
		right 0
		border-left none

.content
	margin-top var(--header-height)
	position relative
	height 100%

.komas
	position relative
	z-index 1

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
	top 0
	width 2px
	margin-left -1px
	z-index 10
	background var(--tq-color-accent)
	height 100%
	color var(--tq-color-on-accent)

	&:before
		pointer-events none
		content ''
		display block
		position absolute
		left 1px
		height var(--header-height)
		width var(--frame-width)
		background var(--tq-color-accent)
		z-index -1

.onionskin
	position absolute
	top calc(var(--header-height) - 4px)
	left calc(var(--frame-width) * var(--onionskin))
	right 100%
	height 4px
	background var(--tq-color-selection)
	opacity 0.5

	&.pos
		left var(--frame-width)
		right auto
		width calc(var(--frame-width) * var(--onionskin))
		border-radius 0 99px 99px 0

.visualizers
	position absolute
	bottom 0
	width 100%

.drawing
	pointer-events none
</style>
