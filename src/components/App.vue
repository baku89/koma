<script lang="ts" setup>
import {extendRef, useEventListener} from '@vueuse/core'
import * as Bndr from 'bndr-js'
import {produce} from 'immer'
import {clamp} from 'lodash'
import Tq, {useTweeq} from 'tweeq'
import {computed, onMounted, Ref, ref} from 'vue'

import {getObjectURL, useProject} from '@/project'
import {useTethr} from '@/use/useTethr'

const project = useProject()

const {registerActions, onBeforeActionPerform} = useTweeq('com.baku89.koma', {
	colorMode: 'dark',
	accentColor: '#ff0000',
})

const {camera, liveviewMediaStream, toggleCameraConnection, configs} =
	useTethr()

const testNumber = ref(0)

function refWithSetter<T>(initialValue: T, setter: (value: T) => T) {
	const r = ref(initialValue) as Ref<T>

	const c = computed<T>({
		get() {
			return r.value
		},
		set(value: T) {
			r.value = setter(value)
		},
	})

	return c
}

const liveToggle = ref(false)
const currentFrame = refWithSetter(0, value => {
	return clamp(value, 0, project.allFrames.value.length - 1)
})

const temporalFrame = ref<null | number>(null) // For previewing, live toggle
const previewFrame = computed(() => {
	if (liveToggle.value) {
		if (currentFrame.value === project.captureFrame.value) {
			return project.captureFrame.value - 1
		} else {
			return project.captureFrame.value
		}
	}

	return temporalFrame.value ?? currentFrame.value
})

Bndr.keyboard()
	.pressed('5')
	.on(pressed => {
		liveToggle.value = pressed
	})

const previewRange = extendRef(ref([0, 0]), {
	setInPoint(value: number) {
		const inPoint = Math.min(value, previewRange.value[1])
		previewRange.value = [inPoint, previewRange.value[1]]
	},
	setOutPoint(value: number) {
		const outPoint = Math.max(value, previewRange.value[0])
		previewRange.value = [previewRange.value[0], outPoint]
	},
})

// Playing
const isLooping = ref(false)
const isPlaying = ref(false)

function togglePlay() {
	isPlaying.value = !isPlaying.value

	if (!isPlaying.value) {
		temporalFrame.value = null
		return
	}

	const startTime = new Date().getTime()

	const [inPoint, outPoint] = previewRange.value
	const duration = outPoint - inPoint + 1

	function update() {
		if (!isPlaying.value) {
			temporalFrame.value = null
			return
		}

		const elapsed = new Date().getTime() - startTime

		const elapsedFrames = Math.round((elapsed / 1000) * 24)

		if (!isLooping.value && elapsedFrames >= duration) {
			temporalFrame.value = outPoint
			isPlaying.value = false
		} else {
			temporalFrame.value = (elapsedFrames % duration) + inPoint
			requestAnimationFrame(update)
		}
	}

	update()
}
onBeforeActionPerform(action => {
	if (action.id !== 'toggle_play') {
		isPlaying.value = false
		temporalFrame.value = null
	}
})

useEventListener(window, 'beforeunload', e => {
	if (project.hasModified.value) {
		e.preventDefault()
		e.returnValue =
			'There are unsaved changes. Are you sure you want to reload?'
	}
})

const $frameMeasure = ref<null | HTMLElement>(null)
onMounted(() => {
	if (!$frameMeasure.value) return

	Bndr.pointer($frameMeasure.value)
		.drag({pointerCapture: true, coordinate: 'offset'})
		.on(d => {
			const frame = Math.floor(d.current[0] / 80)
			currentFrame.value = frame
		})
})

function insertCamera(frame: number) {
	currentFrame.value = frame
	project.data.value = produce(project.data.value, draft => {
		draft.captureFrame = currentFrame.value
	})
}

registerActions([
	{
		id: 'open_project',
		icon: 'folder_open',
		menu: '',
		input: 'command+o',
		async perform() {
			await project.open()
			currentFrame.value = project.data.value.captureFrame
		},
	},
	{
		id: 'save_project',
		icon: 'folder_open',
		input: 'command+s',
		menu: '',
		async perform() {
			await project.save()
		},
	},
	{
		id: 'shoot',
		icon: 'photo_camera',
		input: 'enter',
		menu: '',
		async perform() {
			if (!camera.value) return

			const lv = await camera.value.getLiveViewImage()
			if (lv.status !== 'ok') throw new Error('Failed to get liveview image')

			const result = await camera.value.takePhoto()

			let _jpg: Blob | null = null

			if (result.status === 'ok') {
				for (const object of result.value) {
					if (object.format !== 'raw') {
						_jpg = object.blob
					}
				}
			}

			if (!_jpg) return

			const jpg = _jpg

			project.data.value = produce(project.data.value, draft => {
				draft.frames[draft.captureFrame] = {jpg, lv: lv.value}

				for (let i = draft.captureFrame + 1; i <= draft.frames.length; i++) {
					if (!draft.frames[i]) {
						draft.captureFrame = i
						break
					}
				}
			})

			currentFrame.value = project.captureFrame.value
			previewRange.setOutPoint(project.captureFrame.value)
		},
	},
	{
		id: 'undo',
		icon: 'undo',
		input: 'command+z',
		perform() {
			project.history.undo()
			currentFrame.value = project.captureFrame.value
		},
	},
	{
		id: 'redo',
		icon: 'redo',
		input: 'command+shift+z',
		perform() {
			project.history.redo()
			currentFrame.value = project.captureFrame.value
		},
	},
	{
		id: 'go_forward_1_frame',
		icon: 'arrow_forward',
		input: ['f', 'right'],
		perform() {
			currentFrame.value += 1
		},
	},
	{
		id: 'go_backward_1_frame',
		icon: 'arrow_back',
		input: ['d', 'left'],
		perform() {
			currentFrame.value = Math.max(0, currentFrame.value - 1)
		},
	},
	{
		id: 'delete_current_frame',
		icon: 'backspace',
		input: ['delete', 'backspace'],
		perform() {
			project.data.value = produce(project.data.value, draft => {
				draft.frames.splice(currentFrame.value, 1)
				if (currentFrame.value < draft.captureFrame) {
					draft.captureFrame -= 1
				}
			})
		},
	},
	{
		id: 'insert_camera',
		icon: 'add_a_photo',
		perform() {
			project.data.value = produce(project.data.value, draft => {
				draft.captureFrame = currentFrame.value
			})
		},
	},
	{
		id: 'set_in_point',
		icon: 'line_start_square',
		input: 'b',
		perform() {
			previewRange.setInPoint(currentFrame.value)
		},
	},
	{
		id: 'set_out_point',
		icon: 'line_end_square',
		input: 'n',
		perform() {
			previewRange.setOutPoint(currentFrame.value)
		},
	},
	{
		id: 'toggle_play',
		icon: 'play_arrow',
		input: 'space',
		perform: togglePlay,
	},
	{
		id: 'toggle_loop',
		icon: 'laps',
		input: 'l',
		perform() {
			isLooping.value = !isLooping.value
		},
	},
])

const seekbarStyles = computed(() => {
	return {
		transform: `translateX(calc(${previewFrame.value} * var(--frame-width)))`,
	}
})

const previewRangeStyles = computed(() => {
	const [inPoint, outPoint] = previewRange.value
	return {
		transform: `translateX(calc(${inPoint} * var(--frame-width)))`,
		width: `calc(${outPoint - inPoint + 1} * var(--frame-width) + 1px)`,
	}
})

const isLiveview = computed(() => {
	return previewFrame.value === project.captureFrame.value
})

const currentFrameImage = computed(() => {
	const frame = project.data.value.frames[previewFrame.value]
	if (isLiveview.value || !frame) {
		return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
	}

	return getObjectURL(frame.lv)
})
</script>

<template>
	<div class="App">
		<Tq.CommandPalette />
		<Tq.TitleBar name="Koma" class="title" icon="favicon.svg">
			<template #left>
				<Tq.InputString
					:modelValue="project.data.value.name"
					style="width: 10em"
					@focus="project.pauseHistory()"
					@blur="project.pushHistory()"
					@update:modelValue="
						project.data.value = {...project.data.value, name: $event}
					"
				/>
			</template>
			<template #center>
				<Tq.InputNumber
					:modelValue="previewFrame"
					:precision="0"
					:min="0"
					:max="project.allFrames.value.length - 1"
					:step="1"
					:bar="false"
					unit=" F"
					style="width: 5em"
					@update:modelValue="currentFrame = $event"
				/>
				<Tq.InputIconToggle v-model="isLooping" icon="laps" />
				<Tq.InputIconToggle
					v-model="isPlaying"
					:icon="isPlaying ? 'pause' : 'play_arrow'"
				/>
			</template>
			<template #right>
				<Tq.InputButton
					:label="camera ? configs.model.value ?? 'Unknown' : 'Connect'"
					@click="toggleCameraConnection"
				/>
			</template>
		</Tq.TitleBar>
		<main class="main">
			<Tq.PaneSplit name="timeline" direction="vertical">
				<template #first>
					<Tq.PaneSplit name="preview" direction="horizontal">
						<template #first>
							<div class="view">
								<div class="view-image-wrapper" :class="{liveview: isLiveview}">
									<video
										class="view-video"
										:style="{visibility: isLiveview ? 'visible' : 'hidden'}"
										:srcObject.prop="liveviewMediaStream"
										autoplay
										muted
										playsinline
									/>
									<img :src="currentFrameImage" class="view-photo" />
								</div>
							</div>
						</template>
						<template #second> 3D View </template>
					</Tq.PaneSplit>
				</template>
				<template #second>
					<div class="controls">
						<div class="cameraParameters">
							<div class="heading">Camera Controls</div>
							<Tq.ParameterGrid>
								<Tq.Parameter label="Focal Length">
									<Tq.InputNumber v-model="testNumber" unit="mm" />
								</Tq.Parameter>
								<Tq.Parameter label="Aperture">
									<Tq.InputNumber v-model="testNumber" />
								</Tq.Parameter>
								<Tq.Parameter label="Shutter Speed">
									<Tq.InputNumber v-model="testNumber" />
								</Tq.Parameter>
								<Tq.Parameter label="ISO">
									<Tq.InputNumber
										v-model="testNumber"
										:step="1"
										:min="0"
										:max="100"
									/>
								</Tq.Parameter>
							</Tq.ParameterGrid>
							{{ testNumber }}
						</div>
						<div class="timeline">
							<div
								ref="$frameMeasure"
								class="frameMeasure"
								:style="{
									width: `calc(${project.allFrames.value.length} * var(--frame-width))`,
								}"
							/>
							<div class="seekbar" :style="seekbarStyles">
								{{ previewFrame }}
							</div>
							<div class="previewRange" :style="previewRangeStyles" />
							<div
								v-for="(frame, i) in project.allFrames.value"
								:key="i"
								class="frame"
							>
								<div class="frame-header tq-font-numeric">{{ i }}</div>
								<div
									v-if="i === project.captureFrame.value"
									class="frame-image liveview"
								>
									<span class="material-symbols-outlined"> photo_camera </span>
								</div>
								<img
									v-else-if="frame"
									class="frame-image"
									:src="getObjectURL(frame.lv)"
								/>
								<div
									v-else
									class="frame-image empty"
									@dblclick="insertCamera(i)"
								/>
							</div>
						</div>
					</div>
				</template>
			</Tq.PaneSplit>
		</main>
	</div>
</template>

<style lang="stylus" scoped>


.main
	position fixed
	inset var(--app-margin-top) 0 0

.view
	width 100%
	height 100%
	display flex
	flex-direction column

.view-image-wrapper
	position relative
	display block
	width 100%
	max-width 100%
	aspect-ratio 3 / 2
	margin auto

	&.liveview:before
		position absolute
		content ''
		display block
		inset 0

.view-video,
.view-photo
	position absolute
	width 100%
	height 100%
	transform translateX(-50%)
	left 50%
	border 4px solid transparent
	object-fit contain

.liveview > .view-video
	border-color var(--tq-color-tinted-input-active)


// Controls (Bottom Pane)
.controls
	position relative
	height 100%
	display grid
	grid-template-columns 300px 1fr

.cameraParameters
	margin-right 6px
	padding-right 6px
	border-right 1px solid var(--tq-color-surface-border)
	padding 12px

	.heading
		font-size 14px
		font-weight bold
		margin 0 0 9px

// Timeline
.timeline
	padding 12px 0
	position relative
	display flex
	height 100%
	overflow-x scroll
	overflow-y hidden

	--frame-width 80px
	--header-height 14px

.frameMeasure
	position absolute
	top 0
	height 24px
	background-image linear-gradient(to right, var(--tq-color-on-background) 1px, transparent 1px, transparent var(--frame-width))
	background-size var(--frame-width) 14px
	background-repeat repeat-x
	background-position 0 12px

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
		top 0
		left 1px
		height var(--header-height)
		width var(--frame-width)
		background var(--tq-color-primary)
		z-index -1

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

.frame
	flex 0 0 var(--frame-width)

	&-header
		header-frame-text-style()
		width 100%
		height var(--header-height)
		border-left 1px solid var(--tq-color-on-background)
		margin-bottom 6px

	&-image
		margin-left 1px
		width calc(100% - 1px)
		aspect-ratio 3 / 2
		text-align center
		display flex
		flex-direction column
		justify-content center
		border-radius var(--tq-input-border-radius)

		&.liveview
			background var(--tq-color-primary-container)

		&.empty
			background var(--tq-color-input)
			opacity .2

			&:hover
				background var(--tq-color-input-hover)

		span
			display block
</style>
