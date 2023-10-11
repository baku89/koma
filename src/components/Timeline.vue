<script lang="ts" setup>
import {Icon} from '@iconify/vue'
import {Bndr} from 'bndr-js'
import {ConfigType, WritableConfigNameList} from 'tethr'
import {computed, ref} from 'vue'

import {useProjectStore} from '@/stores/project'
import {useViewportStore} from '@/stores/viewport'
import {useBndr} from '@/use/useBndr'
import {getObjectURL} from '@/util'

const project = useProjectStore()
const viewport = useViewportStore()

const $frameMeasure = ref<null | HTMLElement>(null)

useBndr($frameMeasure, el => {
	Bndr.pointer(el)
		.drag({pointerCapture: true, coordinate: 'offset'})
		.on(d => {
			const frame = Math.floor(d.current[0] / 80)
			viewport.currentFrame = frame
		})
})

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

function printCameraConfigs(configs: Partial<ConfigType>) {
	return Object.entries(configs)
		.filter(([name]) => WritableConfigNameList.includes(name as any))
		.map(([name, value]) => {
			return `${name}: ${value}`
		})
		.join('<br />')
}
</script>

<template>
	<div
		class="Timeline"
		:style="{
			'--koma-width': project.timeline.zoomFactor * 80 + 'px',
		}"
	>
		<div
			ref="$frameMeasure"
			class="frameMeasure"
			:style="{
				width: `calc(${project.allKomas.length} * var(--koma-width))`,
			}"
		/>
		<div class="seekbar" :style="seekbarStyles">
			{{ viewport.previewFrame }}
		</div>
		<div class="previewRange" :style="previewRangeStyles" />
		<div
			v-for="(koma, frame) in project.allKomas"
			:key="frame"
			class="koma"
			@dblclick="project.captureFrame = frame"
		>
			<div class="koma-header tq-font-numeric">{{ frame }}</div>
			<div
				class="shot"
				:class="{onionskin: frame === viewport.onionskin?.frame}"
			>
				<div v-if="frame === project.captureFrame" class="liveview">
					<Icon icon="material-symbols:photo-camera-outline" />
				</div>
				<div
					v-else-if="koma && koma.shots[0]"
					v-tooltip="{
						content: printCameraConfigs(koma.shots[0].cameraConfigs),
						html: true,
					}"
					class="captured"
					:class="{hasRaw: koma.shots[0].raw}"
				>
					<img :src="getObjectURL(koma.shots[0].lv)" />
				</div>
				<div v-else class="empty" />
				<div class="in-between transition" />
			</div>
		</div>
	</div>
</template>

<style lang="stylus" scoped>
.Timeline
	position relative
	display flex
	height 100%
	overflow-x scroll
	overflow-y hidden

	--koma-width 80px
	--koma-height 53px
	--header-height 14px

.frameMeasure
	position absolute
	top 0
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
	width 100%
	height var(--header-height)
	border-left 1px solid var(--tq-color-on-background)
	margin-bottom 6px


.shot
	position relative
	flex 0 0 var(--koma-width)
	margin-left 1px
	width calc(var(--koma-width) - 1px)
	height var(--koma-height)


	&.onionskin:before
		content ''
		display block
		position absolute
		inset 0
		border 3px solid var(--md-sys-color-tertiary)
		border-radius var(--tq-input-border-radius)

	.captured, .liveview, .empty
		width 100%
		height 100%
		text-align center
		display flex
		flex-direction column
		justify-content center
		align-items center
		border-radius var(--tq-input-border-radius)

	.captured
		overflow hidden
		box-shadow inset 0 0 0 1px var(--tq-color-surface-border)

		img
			height 100%
			object-fit contain

		&.hasRaw:before
			content ''
			display block
			position absolute
			bottom 0
			left 2px
			right 2px
			height 2px
			background var(--tq-color-on-primary)

	.liveview
		background var(--tq-color-primary-container)

	.empty
		background var(--tq-color-input)
		opacity .2

		&:hover
			background var(--tq-color-input-hover)

	.in-between
		position absolute
		top 0
		height 100%
		width 12px
		right -6px
		z-index 10

		&:before
			position absolute
			content ''
			display block
			inset 0
			transform scaleX(0)

		&:hover:before
			transform scaleX(1)
			background var(--tq-color-primary)
</style>
