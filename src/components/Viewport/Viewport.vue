<script lang="ts" setup>
import {Icon} from '@iconify/vue'
import {useElementBounding} from '@vueuse/core'
import {mat2d, vec2} from 'linearly'
import {useTweeq} from 'tweeq'
import {computed, shallowRef} from 'vue'

import {useProjectStore} from '@/stores/project'
import {useShootAlertsStore} from '@/stores/shootAlerts'
import {useViewportStore} from '@/stores/viewport'
import {useZUI} from '@/use/useZUI'

import ViewportKoma from './ViewportKoma.vue'
import {Rect} from '@/utils/rect'

const {actions} = useTweeq()
const project = useProjectStore()
const viewport = useViewportStore()
const shootAlerts = useShootAlertsStore()

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

actions.register([
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
</script>

<template>
	<div
		class="Viewport"
		:class="{liveview: viewport.isLiveview, tint}"
		ref="$wrapper"
		:style="{'--tint': 'red'}"
	>
		<div class="frame" :style="frameStyles">
			<ViewportKoma
				class="koma"
				:frame="viewport.previewFrame"
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
		<ul class="shootAlerts">
			<li v-for="(alert, i) in shootAlerts.alerts" :key="i">
				<Icon icon="material-symbols:error" />
				<span>{{ alert }}</span>
			</li>
		</ul>
	</div>
</template>

<style lang="stylus" scoped>
@import '../../../dev_modules/tweeq/src/common.styl'

.Viewport
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
		stroke var(--tq-color-on-background)
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
	border 1px solid var(--tq-color-on-background)
	opacity 1
	background var(--tq-color-background)

	.progress
		position absolute
		top 2px
		bottom 2px
		left 2px
		background var(--tq-color-on-background)
		border-radius 9999px
		transition width 0.5s ease

.shootAlerts
	position absolute
	top 1rem
	right 1rem
	width 260px
	display flex
	flex-direction column
	gap 9px

	li
		display grid
		grid-template-columns min-content 1fr
		background var(--tq-color-surface)
		border-radius var(--tq-input-border-radius)
		backdrop-filter blur(4px)
		padding 1rem
		gap 9px
		line-height 20px
		border 2px solid var(--tq-color-rec)

	.iconify
		color var(--tq-color-error)
</style>
