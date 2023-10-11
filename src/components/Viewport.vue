<script lang="ts" setup>
import {useElementBounding} from '@vueuse/core'
import {mat2d, Vec2} from 'linearly'
import {useActionsStore} from 'tweeq'
import {computed, ref} from 'vue'

import {useCameraStore} from '@/stores/camera'
import {useProjectStore} from '@/stores/project'
import {useViewportStore} from '@/stores/viewport'
import {useZUI} from '@/use/useZUI'
import {getObjectURL} from '@/util'

import {Mat2d} from '../../dev_modules/linearly/src/mat2d'

const actions = useActionsStore()
const project = useProjectStore()
const viewport = useViewportStore()
const camera = useCameraStore()

const transparent =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const $wrapper = ref<HTMLElement | null>(null)

const bound = useElementBounding($wrapper)

const currentFrameImage = computed(() => {
	const frame = project.komas[viewport.previewFrame]?.shots[0]
	if (viewport.isLiveview || !frame) {
		return transparent
	}
	return getObjectURL(viewport.enableHiRes ? frame.jpg : frame.lv)
})

const transform = computed<Mat2d>(() => {
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

			const offset: Vec2 = [0, (bound.height.value - frameHeight) / 2]

			return mat2d.mul(mat2d.fromTranslation(offset), mat2d.fromScaling(scale))
		} else {
			// Fit height
			const scale = bound.height.value / resy
			const frameWidth = resx * scale

			const offset: Vec2 = [(bound.width.value - frameWidth) / 2, 0]

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
		id: 'frame_all',
		input: 'h',
		icon: 'material-symbols:frame-inspect',
		perform() {
			project.viewport.transform = 'fit'
		},
	},
])

const onionskinAttrs = computed(() => {
	if (!viewport.onionskin) return {style: {display: 'none'}}

	const {shot, opacity} = viewport.onionskin

	return {
		src: getObjectURL(viewport.enableHiRes ? shot.jpg : shot.lv),
		style: {
			opacity,
			mixBlendMode: 'normal' as any,
		},
	}
})
</script>

<template>
	<div class="Viewport" :class="{liveview: viewport.isLiveview}">
		<div ref="$wrapper" class="wrapper">
			<div class="frame" :style="frameStyles">
				<video
					class="view-image"
					:class="{'no-camera': !camera.tethr}"
					:style="{
						visibility: viewport.isLiveview ? 'visible' : 'hidden',
					}"
					:srcObject.prop="camera.liveviewMediaStream"
					autoplay
					muted
					playsinline
				/>
				<img
					v-show="!viewport.isLiveview"
					class="view-image"
					:src="currentFrameImage"
				/>
				<img class="view-image onionskin" v-bind="onionskinAttrs" />
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
	</div>
</template>

<style lang="stylus" scope>
.Viewport
	position relative
	border 4px solid transparent
	overflow hidden

	&.liveview
		border-color var(--tq-color-tinted-input-active)

.wrapper
	position relative
	width 100%
	height 100%
	overflow hidden

.frame
	position absolute
	transform-origin 0 0
	background black

.view-image
.view-overlay
	position absolute
	width 100%
	height 100%
	object-fit cover

.view-image.no-camera
	background var(--tq-color-primary)

.view-overlay
	.line
		stroke var(--tq-color-on-background)
		stroke-width 2px
		fill none
		vector-effect non-scaling-stroke
		opacity .2

	.letterbox
		stroke none
		fill var(--tq-color-background)
		opacity .7

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
		transition width .5s ease
</style>
