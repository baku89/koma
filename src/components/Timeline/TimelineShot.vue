<script setup lang="ts">
import {capital} from 'case'
import dateformat from 'dateformat'
import {ConfigNameList} from 'tethr'
import * as Tq from 'tweeq'
import {computed} from 'vue'

import {Shot, useProjectStore} from '@/stores/project'
import {useTimelineStore} from '@/stores/timeline'
import {useViewportStore} from '@/stores/viewport'
import {getObjectURL, toTime} from '@/utils'

interface Props {
	frame: number
	layer: number
}

const props = defineProps<Props>()

const project = useProjectStore()
const viewport = useViewportStore()
const timeline = useTimelineStore()

const shot = computed(() => project.shot(props.frame, props.layer))

const selected = computed(() => {
	return (
		props.frame === viewport.currentFrame &&
		props.layer === viewport.currentLayer &&
		viewport.isShotSelected
	)
})

function insertEmptyFrame(frame: number) {
	project.$patch(state => {
		state.komas.splice(frame, 0, {shots: []})
		if (frame <= state.captureShot.frame) {
			state.captureShot.frame += 1
		}
		if (frame <= project.previewRange[1]) {
			state.previewRange[1] += 1
		}
	})
}

function selectShot() {
	viewport.setCurrentFrame(props.frame)
	viewport.setCurrentLayer(props.layer)
	viewport.selectShot()
}

function printShotInfo(shot: Shot) {
	const infos: [string, string][] = [
		['Capture Date', dateformat(shot.captureDate, 'mmm d, yyyy HH:MM:ss')],
		['Time to Shoot', shot.shootTime ? toTime(shot.shootTime) : '-'],
		['Jpeg Filename', shot.jpgFilename ?? '-'],
		['', ''],
	]

	const configs = Object.entries(shot.cameraConfigs as any).filter(([name]) =>
		ConfigNameList.includes(name as any)
	)

	return [...infos, ...configs]
		.map(([name, value]) => {
			if (name === '') return '<hr />'

			const nameHtml = `<em>${capital(name)}:</em>`
			const valueHtml = `<span class="tq-font-numeric">${value}</span>`
			return nameHtml + ' ' + valueHtml
		})
		.join('<br />')
}
</script>

<template>
	<div
		class="Shot"
		:class="{selected}"
		@click="selectShot"
		@dblclick="project.captureShot = {frame, layer}"
	>
		<div
			v-if="
				frame === project.captureShot.frame &&
				layer === project.captureShot.layer
			"
			class="liveview"
		>
			<Tq.Icon icon="material-symbols:photo-camera-outline" />
		</div>
		<div
			v-else-if="shot"
			v-tooltip="{
				content: printShotInfo(shot),
				html: true,
			}"
			class="captured"
		>
			<img :src="getObjectURL(shot.lv)" />
		</div>
		<div v-else class="empty" />
		<div
			v-if="timeline.frameWidth > 40"
			v-tooltip="'Insert'"
			class="in-between transition"
			@click="insertEmptyFrame(frame)"
		/>
	</div>
</template>

<style scoped lang="stylus">
.Shot
	position relative
	flex 0 0 var(--frame-width)
	margin-left 1px
	width calc(var(--frame-width) - 1px)
	height var(--layer-height)
	overflow hidden

	&.selected:before
		content ''
		display block
		position absolute
		inset 0
		border 2px solid var(--tq-color-selection)
		border-radius var(--tq-radius-input)
		z-index 10
		pointer-events none

.captured
.liveview
.empty
	position relative
	width 100%
	height 100%
	text-align center
	display flex
	flex-direction column
	justify-content center
	align-items center
	border-radius var(--tq-radius-input)

.captured
	overflow hidden
	box-shadow inset 0 0 0 1px var(--tq-color-border)

	img
		height 100%
		object-fit contain

.liveview
	background var(--tq-color-rec)

.empty
	background transparent
	opacity 0.8

	&:hover
		background var(--tq-color-input-hover)

.in-between
	position absolute
	top 0
	height 100%
	width 8px
	left -4px
	z-index 10

	&:before
		position absolute
		content ''
		display block
		inset 0
		transform scaleX(0)

	&:hover:before
		transform scaleX(1)
		background var(--tq-color-accent)
</style>
