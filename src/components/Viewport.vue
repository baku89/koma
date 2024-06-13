<script lang="ts" setup>
import {Icon} from '@iconify/vue'
import {useElementBounding} from '@vueuse/core'
import {mat2d, vec2} from 'linearly'
import {useActionsStore} from 'tweeq'
import {computed, ref} from 'vue'

import {useProjectStore} from '@/stores/project'
import {useShootAlertsStore} from '@/stores/shootAlerts'
import {useViewportStore} from '@/stores/viewport'
import {useZUI} from '@/use/useZUI'

import ViewportKoma from './ViewportKoma.vue'

const actions = useActionsStore()
const project = useProjectStore()
const viewport = useViewportStore()
const shootAlerts = useShootAlertsStore()

const $wrapper = ref<HTMLElement | null>(null)

const bound = useElementBounding($wrapper)

const transform = computed<mat2d>(() => {
	if (project.viewport.transform === 'fit') {
		const {
			resolution: [resx, resy],
		} = project

		const viewportRatio = bound.height.value / bound.width.value
		const frameRatio = resy / resx

		if (frameRatio < viewportRatio) {
			// Fit width
			const scale = bound.width.value / resx
			const frameHeight = resy * scale

			const offset: vec2 = [0, (bound.height.value - frameHeight) / 2]

			return mat2d.mul(mat2d.fromTranslation(offset), mat2d.fromScaling(scale))
		} else {
			// Fit height
			const scale = bound.height.value / resy
			const frameWidth = resx * scale

			const offset: vec2 = [(bound.width.value - frameWidth) / 2, 0]

			return mat2d.mul(mat2d.fromTranslation(offset), mat2d.fromScaling(scale))
		}
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
</script>

<template>
	<div class="Viewport" :class="{liveview: viewport.isLiveview}">
		<div ref="$wrapper" class="wrapper">
			<div class="frame" :style="frameStyles">
				<ViewportKoma class="koma" :frame="viewport.previewFrame" />
				<ViewportKoma
					v-for="({frame, opacity}, i) in viewport.onionskin"
					:key="i"
					class="koma"
					:frame="frame"
					:style="{opacity}"
				/>
				<svg
					class="view-overlay"
					viewBox="0 0 1 1"
					preserveAspectRatio="none"
					v-html="project.viewport.overlay"
				></svg>
			</div>
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

<style lang="stylus" scope>
@import '../../dev_modules/tweeq/src/common.styl'

.Viewport
	position relative
	border 4px solid transparent
	overflow hidden

	&.liveview
		border-color var(--tq-color-rec)

.wrapper
	position relative
	width 100%
	height 100%
	overflow hidden

.frame
	position absolute
	transform-origin 0 0
	background black
	overflow hidden

.view-overlay
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
