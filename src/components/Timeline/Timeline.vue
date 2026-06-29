<script lang="ts" setup>
import {vec2} from 'linearly'
import {range as _range} from 'lodash-es'
import * as Tq from 'tweeq'
import {computed, nextTick, onMounted, ref, watch} from 'vue'

import {MixBlendModeValues, useProjectStore} from '@/stores/project'
import {useSelectionStore} from '@/stores/selection'
import {useTimelineStore} from '@/stores/timeline'
import {useViewportStore} from '@/stores/viewport'

import Waveform from '../Waveform.vue'
import TimelineDrawing from './TimelineDrawing.vue'
import TimelineGraph from './TimelineGraph.vue'
import TimelineKoma from './TimelineKoma.vue'
import TimelineMarkers from './TimelineMarkers.vue'
import TimelineToolCursor from './TimelineToolCursor.vue'

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

// When a project finishes loading, scroll so its capture frame is centered.
async function centerOnCaptureShot() {
	await nextTick()
	$timeline.value?.centerFrame(project.captureShot.frame)
}

watch(
	() => project.isOpening,
	(opening, wasOpening) => {
		if (wasOpening && !opening) centerOnCaptureShot()
	}
)

// Also handle the initial auto-loaded project, whose open() may have already
// finished before this component mounted (so the watch above never fires).
onMounted(() => {
	if (!project.isOpening) centerOnCaptureShot()
})

function onDragRuler(value: number) {
	const frame = Math.floor(value)
	viewport.setCurrentFrame(frame)
	viewport.isPlaying = false
}

//------------------------------------------------------------------------------
// Preview range の左右ドラッグ

type PreviewDragMode = 'start' | 'end'

let previewDragMode: PreviewDragMode | null = null
let previewDragStartX = 0
let previewDragStartRange: vec2 = [0, 0]
let previewDragBatching = false

function onPreviewDown(mode: PreviewDragMode, e: PointerEvent) {
	previewDragMode = mode
	previewDragStartX = e.clientX
	previewDragStartRange = [...project.previewRange]
	;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onPreviewMove(e: PointerEvent) {
	if (!previewDragMode) return

	// pointerup / pointercancel を取りこぼしても、ボタン未押下の move
	// （＝ただのホバー）が来たらドラッグ終了とみなす。これが無いと
	// state が残ったままホバーで in/out が勝手に追従してしまう。
	if (e.buttons === 0) {
		onPreviewUp()
		return
	}

	if (!previewDragBatching) {
		previewDragBatching = true
		project.beginAutosaveBatch()
	}

	const deltaFrame = Math.round(
		(e.clientX - previewDragStartX) / timeline.frameWidth
	)
	const [origIn, origOut] = previewDragStartRange

	if (previewDragMode === 'start') {
		project.setInPoint(origIn + deltaFrame)
	} else {
		project.setOutPoint(origOut + deltaFrame)
	}
}

function onPreviewUp() {
	if (!previewDragMode) return
	previewDragMode = null
	if (previewDragBatching) {
		previewDragBatching = false
		project.endAutosaveBatch()
	}
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

	// The frame past the last koma (last frame + 1) is selectable as the capture
	// slot, but it isn't a real koma — so don't number it (or anything beyond).
	const lastNumbered = project.duration - 1

	if (unitWidth > 20) {
		return _range(start, end + 1)
			.filter((value: number) => value <= lastNumbered)
			.map((value: number) => ({
				value,
				label: value.toString(),
			}))
	} else {
		const fps = project.fps
		return _range(start, end)
			.filter((f: number) => f % fps === 0 && f <= lastNumbered)
			.map((value: number) => ({value, label: value.toString()}))
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
			:frameRange="[0, project.allKomas.length]"
			v-model:frameWidth="timeline.frameWidth"
			:frameWidthRange="[10, timeline.frameWidthBase]"
			@confirm="timeline.confirmZoom"
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
				<div class="preview-range" :style="rangeStyle(project.previewRange)">
					<div
						class="handle start"
						@pointerdown.stop="onPreviewDown('start', $event)"
						@pointermove="onPreviewMove"
						@pointerup="onPreviewUp"
						@pointercancel="onPreviewUp"
						@lostpointercapture="onPreviewUp"
					/>
					<div
						class="handle end"
						@pointerdown.stop="onPreviewDown('end', $event)"
						@pointermove="onPreviewMove"
						@pointerup="onPreviewUp"
						@pointercancel="onPreviewUp"
						@lostpointercapture="onPreviewUp"
					/>
				</div>
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
					v-if="project.audio.src"
					:src="project.audio.src"
					:range="[range[0] / project.fps, range[1] / project.fps]"
				/>
				<TimelineGraph :style="rangeStyle(project.previewRange)" />
				<TimelineDrawing class="drawing" :range="range" />
				<TimelineMarkers :range="range" :rangeStyle="rangeStyle" />
			</div>

			<TimelineToolCursor :range="range" />
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
	position relative
	background set-alpha(--tq-color-text, 0.2)

	.handle
		position absolute
		top 0
		width 6px
		height 100%
		border 1px solid var(--tq-color-text)
		cursor ew-resize

		&.start
			left 0
			border-right none

		&.end
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
	// Keep markers / the line graph / waveform clear of the horizontal scrollbar
	// sitting just below the timeline content, instead of running flush into it.
	bottom var(--tq-scrollbar-width)
	width 100%

.drawing
	pointer-events none
</style>
