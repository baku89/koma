<script lang="ts" setup>
import {useEventListener} from '@vueuse/core'
import {vec2} from 'linearly'
import {range as _range} from 'lodash-es'
import * as Tq from 'tweeq'
import {computed, nextTick, onMounted, ref, shallowRef, watch} from 'vue'

import {useProjectStore} from '@/stores/project'
import {useSelectionStore} from '@/stores/selection'
import {useTimelineStore} from '@/stores/timeline'
import {useViewportStore} from '@/stores/viewport'

import Waveform from '../Waveform.vue'
import LayerViewPopover from './LayerViewPopover.vue'
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
const {actions} = Tq.useTweeq()

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

/** The layer whose display settings balloon is open, and the button it hangs from. */
const viewPopoverLayer = ref<number | null>(null)
const viewPopoverRef = shallowRef<HTMLElement | null>(null)

/** The sliders icon beside a layer's name: its display settings. */
function toggleViewPopover(index: number, e: MouseEvent) {
	if (viewPopoverLayer.value === index) {
		viewPopoverLayer.value = null
		return
	}
	const anchor = e.currentTarget as HTMLElement
	const open = () => {
		viewPopoverRef.value = anchor
		viewPopoverLayer.value = index
	}
	if (viewPopoverLayer.value === null) return open()
	// Another layer's balloon: this press's light dismiss has just closed it, and
	// its `toggle` event is still to come. Open after that.
	viewPopoverLayer.value = null
	setTimeout(open, 50)
}

// Whether a pointer is down right now: contextmenu's `buttons` can't be relied on.
const pointerPressed = ref(false)
useEventListener(window, 'pointerdown', () => (pointerPressed.value = true), {capture: true})
useEventListener(window, 'pointerup', () => (pointerPressed.value = false), {capture: true})
useEventListener(window, 'pointercancel', () => (pointerPressed.value = false), {capture: true})

/**
 * Right-click on a layer's row: the same. Opens only after the button is
 * released and that release's light dismiss has settled: Chrome closes an auto
 * popover on the pointerup after a pointerdown it wasn't there for, and macOS
 * fires contextmenu on the press.
 */
function openViewPopover(index: number, e: MouseEvent) {
	e.preventDefault()
	const row = e.currentTarget as HTMLElement
	const anchor = row.querySelector<HTMLElement>('.layer-view') ?? row
	const open = () =>
		setTimeout(() => {
			viewPopoverRef.value = anchor
			viewPopoverLayer.value = index
		}, 50)
	if (pointerPressed.value) window.addEventListener('pointerup', open, {once: true})
	else open()
}

//------------------------------------------------------------------------------
// Width of the layer names column

const LAYER_COLUMN_MIN = 60
const LAYER_COLUMN_MAX = 480

const $aside = ref<HTMLElement | null>(null)

function setLayerColumnWidth(width: number) {
	timeline.layerColumnWidth = Math.round(Math.min(LAYER_COLUMN_MAX, Math.max(LAYER_COLUMN_MIN, width)))
}

function startResizeColumn(e: PointerEvent) {
	if (e.button !== 0) return
	const handle = e.currentTarget as HTMLElement
	const offset = timeline.layerColumnWidth - e.clientX
	const onMove = (ev: PointerEvent) => setLayerColumnWidth(ev.clientX + offset)
	const onEnd = () => {
		handle.removeEventListener('pointermove', onMove)
		handle.removeEventListener('pointerup', onEnd)
		handle.removeEventListener('pointercancel', onEnd)
	}
	handle.setPointerCapture(e.pointerId)
	handle.addEventListener('pointermove', onMove)
	handle.addEventListener('pointerup', onEnd)
	handle.addEventListener('pointercancel', onEnd)
}

/** Just wide enough for the longest name. */
function fitColumnToNames() {
	const names = $aside.value?.querySelectorAll<HTMLElement>('.layer-name')
	if (!names?.length) return
	let extra = 0
	for (const name of names) {
		const row = name.parentElement as HTMLElement
		extra = Math.max(extra, name.scrollWidth + row.offsetWidth - name.clientWidth)
	}
	setLayerColumnWidth(extra + 1)
}

/** The timeline's rows in display order, with their storage index. */
const layers = computed(() =>
	project.timelineLayerIndices.map(index => ({
		index,
		layer: project.layer(index),
		visible: project.isLayerVisible(index),
		shown: project.isLayerShown(index),
	}))
)

/** Layers without a row, listed under the names so their rows can come back. */
const offTimelineLayers = computed(() =>
	project.layerStack.flatMap(v => {
		const index = project.layers.findIndex(l => l.id === v.layerId)
		return index === -1 || project.timelineLayerIndices.includes(index)
			? []
			: [{index, name: project.layers[index].name}]
	})
)

const $offTimelineButton = shallowRef<HTMLElement | null>(null)
const offTimelineOpen = ref(false)
// The press's light dismiss closes the list before the click: toggle from the
// state at the press, or a click on the open list would reopen it.
const offTimelineWasOpen = ref(false)

function restoreRow(index: number) {
	project.setLayerOnTimeline(index, true)
	if (offTimelineLayers.value.length === 0) offTimelineOpen.value = false
}

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
			'--layer-column-width': timeline.layerColumnWidth + 'px',
			'--frame-width': timeline.frameWidth + 'px',
			'--layer-height': timeline.layerHeight + 'px',
			'--onionskin': project.onionskin,
		}"
		@pointerdown="appSelection.reserveUnselect"
	>
		<aside ref="$aside" class="aside">
			<div
				v-for="{index, layer, visible, shown} in layers"
				:key="layer.id"
				class="layer-control"
				:class="{current: index === viewport.currentLayer, hidden: !shown}"
				@contextmenu="openViewPopover(index, $event)"
			>
				<button
					class="layer-eye"
					:title="visible ? 'Hide layer' : 'Show layer'"
					@click="project.setLayerVisible(index, !visible)"
				>
					<Tq.Icon :icon="visible ? 'mdi:eye' : 'mdi:eye-off'" />
				</button>
				<button
					class="layer-name"
					:title="`${layer.name} (slot ${index})`"
					@click="actions.perform('layers')"
				>
					{{ layer.name }}
				</button>
				<button
					class="layer-view"
					:class="{active: viewPopoverLayer === index}"
					title="Blend / opacity / transform"
					@click="toggleViewPopover(index, $event)"
				>
					<Tq.Icon icon="mdi:tune-variant" />
				</button>
			</div>
			<button
				v-if="offTimelineLayers.length > 0"
				ref="$offTimelineButton"
				class="off-timeline"
				title="Layers not on the timeline"
				@pointerdown="offTimelineWasOpen = offTimelineOpen"
				@click="offTimelineOpen = !offTimelineWasOpen"
			>
				<Tq.Icon icon="mdi:plus" />
				{{ offTimelineLayers.length }} more
			</button>
			<Tq.Popover
				:reference="$offTimelineButton"
				:open="offTimelineOpen && offTimelineLayers.length > 0"
				placement="right-end"
				arrow
				@update:open="offTimelineOpen = $event"
			>
				<div class="off-timeline-list">
					<button
						v-for="{index, name} in offTimelineLayers"
						:key="index"
						@click="restoreRow(index)"
					>
						{{ name }}
					</button>
				</div>
			</Tq.Popover>
			<div
				class="layer-column-handle"
				title="Drag to resize. Double-click to fit the names."
				@pointerdown.stop="startResizeColumn"
				@dblclick="fitColumnToNames"
			/>
		</aside>
		<LayerViewPopover
			:reference="viewPopoverRef"
			:layer="viewPopoverLayer"
			@close="viewPopoverLayer = null"
		/>
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
	grid-template-columns var(--layer-column-width) minmax(0, 1fr)
	--header-height 14px
	--header-margin-bottom 6px

.aside
	padding-top calc(var(--header-height) + var(--header-margin-bottom))
	// Thin divider between the layer names and the frames.
	border-right 1px solid var(--tq-color-border)
	position relative
	min-width 0

// Straddles the divider so it is easy to catch.
.layer-column-handle
	position absolute
	top 0
	bottom 0
	right -4px
	width 7px
	z-index 2
	cursor col-resize

	&:hover
	&:active
		background var(--tq-color-accent)
		opacity 0.5

.layer-control
	--tq-input-height 20px
	height var(--layer-height)
	padding 0 9px 0 4px
	display flex
	align-items center
	gap 2px

	// Separator between layer names only; the frame area stays as it is.
	& + &
		border-top 1px solid var(--tq-color-border)

	&.current .layer-name
		color var(--tq-color-accent)

	&.hidden .layer-name
		color var(--tq-color-text-mute)

// The eye: show / hide in the active preset, same as the Layers dialog.
// The sliders icon opens the display-settings balloon (LayerViewPopover).
.layer-eye
.layer-view
	flex 0 0 auto
	width var(--tq-input-height)
	height var(--tq-input-height)
	display flex
	align-items center
	justify-content center
	color var(--tq-color-text-mute)
	cursor pointer

	&:hover
		color var(--tq-color-text)

	.hidden &
		opacity 0.5

// Just the name; blend / opacity / transform are behind the sliders icon.
.layer-view.active
	color var(--tq-color-accent)

.layer-name
	flex 1 1 auto
	min-width 0
	height var(--tq-input-height)
	text-align left
	font-weight bold
	font-size 0.9em
	white-space nowrap
	overflow hidden
	text-overflow ellipsis
	cursor pointer

	&:hover
		color var(--tq-color-text)

.off-timeline
	display flex
	align-items center
	gap 2px
	height 20px
	padding 0 4px
	font-size 0.85em
	color var(--tq-color-text-mute)
	cursor pointer

	&:hover
		color var(--tq-color-text)

.off-timeline-list
	display flex
	flex-direction column
	min-width 8rem
	max-width 20rem
	max-height 50vh
	overflow-y auto

	button
		padding 0.3em 0.5em
		text-align left
		white-space nowrap
		overflow hidden
		text-overflow ellipsis
		cursor pointer

		&:hover
			color var(--tq-color-accent)

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
