<script lang="ts" setup>
import {useElementBounding} from '@vueuse/core'
import {mat2d, vec2} from 'linearly'
import {useTweeq} from 'tweeq'
import {computed, ref, shallowRef, watch} from 'vue'

import {useCameraStore} from '@/stores/camera'
import {useProjectStore} from '@/stores/project'
import {useShootAlertsStore} from '@/stores/shootAlerts'
import {useTrackerStore} from '@/stores/tracker'
import {useViewportStore} from '@/stores/viewport'
import {useZUI} from '@/use/useZUI'
import {Rect} from '@/utils/Rect'

import ViewportKoma from './PreviewKoma.vue'
import PreviewPlayback from './PreviewPlayback.vue'

const Tq = useTweeq()
const project = useProjectStore()
const camera = useCameraStore()
const viewport = useViewportStore()
const tracker = useTrackerStore()
const shootAlerts = useShootAlertsStore()

// Two top-right overlay panes (viewport settings / shoot alerts). Settings is
// an ordinary hover pane. Alerts are persistent: shown by default whenever any
// exist, never light-dismissed, and folded away only while settings is up (the
// two are exclusive) or after the user explicitly clicks the collapse chevron.
// A blocked shutter re-reveals them (see the revealNonce watch below).
const settingsOpen = ref(false)
const alertsDismissed = ref(false)

const hasAlerts = computed(() => shootAlerts.alerts.length > 0)
const alertsOpen = computed(
	() => hasAlerts.value && !settingsOpen.value && !alertsDismissed.value
)

// A fresh batch of alerts re-asserts itself even if previously dismissed.
watch(hasAlerts, has => {
	if (has) alertsDismissed.value = false
})

// A blocked shutter re-reveals the alerts even if the user had collapsed them,
// so the reason the shot refused is back in view.
watch(
	() => shootAlerts.revealNonce,
	() => (alertsDismissed.value = false)
)

function onAlertsToggle(open: boolean) {
	if (open) {
		// Clicking the collapsed button un-dismisses the alerts and closes settings.
		alertsDismissed.value = false
		settingsOpen.value = false
	} else if (!settingsOpen.value) {
		// Collapsed by the user (chevron click), not by settings taking over →
		// keep it folded.
		alertsDismissed.value = true
	}
}

const $wrapper = shallowRef<HTMLElement | null>(null)

const bound = useElementBounding($wrapper)

const transform = computed<mat2d>(() => {
	if (project.viewport.transform === 'fit') {
		let frameRect = Rect.fromSize(project.resolution)
		const viewportRect = Rect.fromSize([bound.width.value, bound.height.value])

		frameRect = Rect.scale(
			frameRect,
			project.viewport.zoom,
			Rect.center(frameRect)
		)

		return Rect.objectFit(frameRect, viewportRect)
	} else {
		return project.viewport.transform
	}
})

const frameStyles = computed(() => {
	const matrix = `matrix(${transform.value.join(',')})`

	return {
		width: project.resolution[0] + 'px',
		height: project.resolution[1] + 'px',
		transform: `${matrix}`,
	}
})

useZUI($wrapper, delta => {
	project.viewport.transform = mat2d.mul(delta, transform.value)
})

Tq.actions.register([
	{
		id: 'viewport',
		children: [
			{
				id: 'frame_all',
				bind: 'h',
				icon: 'material-symbols:frame-inspect',
				perform() {
					project.viewport.transform = 'fit'
				},
			},
		],
	},
])

const tint = computed(
	() =>
		viewport.enableOnionskin &&
		viewport.coloredOnionskin &&
		!viewport.isPlaying &&
		viewport.currentLayer === 0
)

async function onDblclick(e: MouseEvent) {
	const {tethr} = camera

	if (!tethr) return

	const {offsetX, offsetY} = e
	const {resolution} = project
	let pos: vec2 = [offsetX / resolution[0], offsetY / resolution[1]]

	const xform = mat2d.scaling(1 / project.viewport.zoom, [0.5, 0.5])

	pos = vec2.transformMat2d(pos, xform)

	await tethr.setAutoFocusFrameCenter(pos)
	await tethr.runAutoFocus()
}
</script>

<template>
	<div
		class="Preview"
		:class="{liveview: viewport.isLiveview, tint}"
		ref="$wrapper"
		:style="{'--tint': 'red'}"
	>
		<div class="frame" :style="frameStyles" @click="onDblclick">
			<!--
				Static render (paused / scrubbing): full DOM path with onionskin,
				live view, layers and tint. Hidden while playing, and its frame is
				frozen so the off-screen <img>s don't churn through decodes.
			-->
			<div class="komas" v-show="!viewport.isPlaying">
				<ViewportKoma
					class="koma"
					:frame="viewport.isPlaying ? viewport.currentFrame : viewport.previewFrame"
					:class="{tint}"
				/>
				<ViewportKoma
					v-for="({frame, opacity, tint}, i) in viewport.onionskin"
					:key="i"
					class="koma"
					:class="{tint}"
					:frame="frame"
					:style="{opacity, '--tint': tint}"
				/>
			</div>
			<!--
				The playback canvas goes transparent on the live capture frame (it has
				no decoded shot). Render the live-view koma under it during playback so
				the real-time camera feed shows through there instead of a black gap —
				the preview range loops up to the capture frame, so the playhead lands
				on it every loop.
			-->
			<ViewportKoma
				v-if="viewport.isPlaying"
				class="koma"
				:frame="project.captureShot.frame"
			/>
			<!-- Smooth playback: pre-decoded ImageBitmaps blitted to a canvas. -->
			<PreviewPlayback v-show="viewport.isPlaying" />
			<svg
				class="view-overlay"
				viewBox="0 0 1 1"
				preserveAspectRatio="none"
				v-html="project.viewport.overlay"
			/>
		</div>
		<div v-if="viewport.popup?.type === 'progress'" class="popupProgress">
			<div
				class="progress"
				:style="{
					width: `calc(${viewport.popup.progress * 100}% - 4px)`,
				}"
			/>
		</div>
		<div class="viewportOverlay">
			<Tq.PaneExpandable
				icon="mdi:tune"
				placement="bottom-end"
				:open="settingsOpen"
				@update:open="settingsOpen = $event"
			>
				<Tq.ParameterGrid>
					<Tq.ParameterHeading>Preview Settings</Tq.ParameterHeading>
					<Tq.Parameter
						icon="fluent-emoji-high-contrast:onion"
						label="Onionskin Depth"
						:hint="{
							title: 'Onionskin',
							description: 'Ghost previous frames to gauge motion',
						}"
					>
						<Tq.InputNumber
							v-model="project.onionskin"
							:max="0"
							:min="-3"
							:step="0.1"
							suffix="F"
						/>
					</Tq.Parameter>
					<Tq.Parameter
						label="Trajectory Smoothing"
						icon="ooui:map-trail"
						:hint="{
							title: 'Trajectory averaging',
							description:
								'Number of tracker samples to smooth the camera path',
						}"
					>
						<Tq.InputNumber
							v-model="tracker.averageSamples"
							:min="0"
							:max="3"
							:step="1"
						/>
					</Tq.Parameter>
					<Tq.Parameter
						label="Preview Zoom"
						icon="material-symbols:zoom-in"
						hint="Magnify the preview"
					>
						<Tq.InputNumber
							v-model="project.viewport.zoom"
							:min="1"
							:max="1.5"
							:step="0.05"
						/>
					</Tq.Parameter>
				</Tq.ParameterGrid>
			</Tq.PaneExpandable>

			<Tq.PaneExpandable
				v-if="hasAlerts"
				class="alerts"
				:class="{collapsedAlert: !alertsOpen}"
				icon="material-symbols:error"
				placement="bottom-end"
				persistent
				:open="alertsOpen"
				@update:open="onAlertsToggle($event)"
			>
				<ul class="alert-list">
					<li v-for="(alert, i) in shootAlerts.alerts" :key="i">
						<Tq.Icon icon="material-symbols:error" />
						<span>{{ alert }}</span>
					</li>
				</ul>
			</Tq.PaneExpandable>
		</div>
	</div>
</template>

<style lang="stylus" scoped>
@import '../../../dev_modules/tweeq/src/common.styl'

.Preview
	position relative
	border 4px solid transparent
	overflow hidden

	&.liveview
		border-color var(--tq-color-rec)

.frame
	position absolute
	transform-origin 0 0
	background black

	&:before
		content ''
		display block
		position absolute
		inset 0
		outline 600px solid var(--tq-color-background)
		pointer-events none
		z-index 10
		opacity 0.7

.komas
	position absolute
	inset 0

.koma
	&.tint
		mix-blend-mode screen

		&:after
			content ''
			display block
			position absolute
			inset 0
			background var(--tint)
			mix-blend-mode multiply

:deep(.view-overlay)
	position absolute
	top 0
	left 0
	width 100%
	height 100%
	pointer-events none

	.line
		stroke var(--tq-color-text)
		stroke-width 2px
		fill none
		vector-effect non-scaling-stroke
		opacity 0.2

	.letterbox
		stroke none
		fill var(--tq-color-background)
		opacity 0.7

.popupProgress
	left 50%
	top 50%
	position absolute
	transform translate(-50%, -50%)
	width 30%
	height var(--tq-input-height)
	border-radius 9999px
	overflow hidden
	border 1px solid var(--tq-color-text)
	opacity 1
	background var(--tq-color-background)

	.progress
		position absolute
		top 2px
		bottom 2px
		left 2px
		background var(--tq-color-text)
		border-radius 9999px
		transition width 0.5s ease

.viewportOverlay
	position absolute
	top 1rem
	right 1rem
	display flex
	gap var(--tq-gap-control)

// Shoot alerts list, shown inside the alerts pane's balloon.
:deep(.alert-list)
	width 18rem
	display flex
	flex-direction column
	gap 9px

	li
		display grid
		grid-template-columns min-content 1fr
		gap 9px
		line-height 20px
		align-items center

	.iconify
		color var(--tq-color-error)

// When there are alerts but the pane is collapsed, flag the round button red.
:deep(.alerts.collapsedAlert .button)
	color var(--tq-color-error)
	border-color var(--tq-color-error)
</style>
