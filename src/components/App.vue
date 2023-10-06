<script lang="ts" setup>
import {Icon} from '@iconify/vue'
import {useEventListener} from '@vueuse/core'
import {Bndr} from 'bndr-js'
import {produce} from 'immer'
import {clamp} from 'lodash'
import Tq, {useTweeq} from 'tweeq'
import {computed, ref, shallowRef, watch} from 'vue'

import {playSound} from '@/playSound'
import {getObjectURL, Shot, useProject} from '@/project'
import {refWithSetter} from '@/use/refWithSetter'
import {useBndr} from '@/use/useBndr'
import {useTethr} from '@/use/useTethr'

import {lerp} from '../../dev_modules/linearly/src/scalar'
import TethrConfig from './TethrConfig.vue'

const project = useProject()

const {registerActions, onBeforeActionPerform} = useTweeq('com.baku89.koma', {
	colorMode: 'dark',
	accentColor: '#ff0000',
})

const {
	camera,
	liveviewMediaStream,
	toggleCameraConnection,
	configs: cameraConfigs,
} = useTethr()

const liveToggle = ref(false)
const enableHiRes = ref(false)

const currentFrame = refWithSetter(0, value => {
	return clamp(value, 0, project.allKomas.value.length - 1)
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

Bndr.or(Bndr.keyboard().pressed('5'), Bndr.gamepad().button('x')).on(
	pressed => {
		liveToggle.value = pressed
	}
)

//------------------------------------------------------------------------------
// Viewport popup

type ViewportPopup = null | {type: 'progress'; progress: number}

const viewportPopup = shallowRef<ViewportPopup>(null)

//------------------------------------------------------------------------------
// Playing
const isLooping = ref(false)
const isPlaying = ref(false)

function togglePlay() {
	isPlaying.value = !isPlaying.value
}

watch(isPlaying, () => {
	if (!isPlaying.value) {
		temporalFrame.value = null
		return
	}

	const startTime = new Date().getTime()

	const [inPoint, outPoint] = project.state.previewRange
	const duration = outPoint - inPoint + 1
	const {fps} = project.data.value

	function update() {
		if (!isPlaying.value) {
			temporalFrame.value = null
			return
		}

		const elapsed = new Date().getTime() - startTime

		const elapsedFrames = Math.round((elapsed / 1000) * fps)

		if (!isLooping.value && elapsedFrames >= duration) {
			currentFrame.value = outPoint
			isPlaying.value = false
		} else {
			temporalFrame.value = (elapsedFrames % duration) + inPoint
			requestAnimationFrame(update)
		}
	}

	update()
})

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

//------------------------------------------------------------------------------
// Seek bar
const $frameMeasure = ref<null | HTMLElement>(null)

useBndr($frameMeasure, el => {
	Bndr.pointer(el)
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

//------------------------------------------------------------------------------
registerActions([
	{
		id: 'open_project',
		icon: 'material-symbols:folder-open-rounded',
		menu: '',
		input: 'command+o',
		async perform() {
			await project.open()
			currentFrame.value = project.data.value.captureFrame
		},
	},
	{
		id: 'save_project',
		icon: 'mdi:content-save',
		input: 'command+s',
		menu: '',
		async perform() {
			await project.save()
		},
	},
	{
		id: 'shoot',
		icon: 'mdi:circle',
		input: ['enter', 'gamepad:r'],
		menu: '',
		async perform() {
			if (!camera.value) return

			try {
				viewportPopup.value = {
					type: 'progress',
					progress: 0,
				}

				playSound('sound/Camera-Phone03-1.mp3')
				const timeStart = new Date().getTime()

				const lv = await camera.value.getLiveViewImage()
				if (lv.status !== 'ok') throw new Error('Failed to get liveview image')

				viewportPopup.value = {
					type: 'progress',
					progress: 0.1,
				}

				const onProgress = ({progress}: {progress: number}) => {
					viewportPopup.value = {
						type: 'progress',
						progress: lerp(0.1, 1, progress),
					}
				}
				camera.value.on('progress', onProgress)

				const result = await camera.value.takePhoto()

				camera.value.off('progress', onProgress)

				let _jpg: Blob | undefined
				let raw: Blob | undefined

				if (result.status === 'ok') {
					for (const object of result.value) {
						const format = String(object.format)

						if (/jpe?g/.test(format)) {
							_jpg = object.blob
						} else {
							raw = object.blob
						}
					}
				}

				if (!_jpg) return

				const jpg = _jpg

				project.data.value = produce(project.data.value, draft => {
					const shot: Shot = {
						jpg,
						raw,
						lv: lv.value,
						cameraConfigs: {},
					}

					const koma = draft.komas[currentFrame.value]

					if (koma) {
						// If there is already a shot, replace it
						koma.shots[0] = shot
					} else {
						// Otherwise, create a new frame
						draft.komas[currentFrame.value] = {
							shots: [shot],
							backupShots: [],
						}
					}

					// Find next empty frame
					for (let i = draft.captureFrame + 1; i <= draft.komas.length; i++) {
						if (!draft.komas[i]) {
							draft.captureFrame = i
							break
						}
					}
				})

				currentFrame.value = project.captureFrame.value
				project.setOutPoint(project.captureFrame.value)

				if (new Date().getTime() - timeStart > 500) {
					playSound('sound/Accent36-1.mp3')
				}
			} finally {
				viewportPopup.value = null
			}
		},
	},
	{
		id: 'undo',
		icon: 'mdi:undo',
		input: 'command+z',
		perform() {
			project.history.undo()
			currentFrame.value = project.captureFrame.value
		},
	},
	{
		id: 'redo',
		icon: 'mdi:redo',
		input: 'command+shift+z',
		perform() {
			project.history.redo()
			currentFrame.value = project.captureFrame.value
		},
	},
	{
		id: 'go_forward_1_frame',
		icon: 'lucide:step-forward',
		input: ['f', 'right'],
		perform() {
			currentFrame.value += 1
		},
	},
	{
		id: 'go_backward_1_frame',
		icon: 'lucide:step-back',
		input: ['d', 'left'],
		perform() {
			currentFrame.value = Math.max(0, currentFrame.value - 1)
		},
	},
	{
		id: 'delete_current_frame',
		icon: 'mdi:backspace',
		input: ['delete', 'backspace', 'gamepad:home'],
		perform() {
			project.data.value = produce(project.data.value, draft => {
				draft.komas.splice(currentFrame.value, 1)
				if (currentFrame.value < draft.captureFrame) {
					draft.captureFrame -= 1
				}
			})
			playSound('sound/Hit08-1.mp3')
		},
	},
	{
		id: 'insert_camera',
		icon: 'mdi:camera-plus',
		perform() {
			project.data.value = produce(project.data.value, draft => {
				draft.captureFrame = currentFrame.value
			})
		},
	},
	{
		id: 'set_in_point',
		icon: 'mdi:contain-start',
		input: 'b',
		perform() {
			project.setInPoint(currentFrame.value)
		},
	},
	{
		id: 'set_out_point',
		icon: 'mdi:contain-end',
		input: 'n',
		perform() {
			project.setOutPoint(currentFrame.value)
		},
	},
	{
		id: 'toggle_play',
		icon: 'mdi:play',
		input: 'space',
		perform: togglePlay,
	},
	{
		id: 'toggle_loop',
		icon: 'material-symbols:laps',
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
	const [inPoint, outPoint] = project.state.previewRange
	return {
		transform: `translateX(calc(${inPoint} * var(--frame-width)))`,
		width: `calc(${outPoint - inPoint + 1} * var(--frame-width) + 1px)`,
	}
})

const isLiveview = computed(() => {
	return previewFrame.value === project.captureFrame.value
})

const transparent =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const currentFrameImage = computed(() => {
	const frame = project.data.value.komas[previewFrame.value]?.shots[0]
	if (isLiveview.value || !frame) {
		return transparent
	}

	return getObjectURL(enableHiRes.value ? frame.jpg : frame.lv)
})

const onionskinAttrs = computed(() => {
	const {onionskin} = project.state

	const delta = onionskin < 0 ? -1 : 1
	const frame = project.data.value.komas[previewFrame.value + delta]?.shots[0]
	if (!frame) {
		return {
			style: {display: 'none'},
		}
	}

	const opacity = onionskin % 1 === 0 ? 1 : Math.abs(onionskin) % 1

	return {
		src: getObjectURL(enableHiRes.value ? frame.jpg : frame.lv),
		style: {
			opacity,
		},
	}
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
					:max="project.allKomas.value.length - 1"
					:step="1"
					:bar="false"
					unit=" F"
					style="width: 5em"
					@update:modelValue="currentFrame = $event"
				/>
				<Tq.InputIconToggle v-model="isLooping" icon="material-symbols:laps" />
				<Tq.InputIconToggle
					v-model="isPlaying"
					:icon="isPlaying ? 'mdi:pause' : 'mdi:play'"
				/>
				<Tq.InputIconToggle v-model="enableHiRes" icon="mdi:high-definition" />
			</template>
			<template #right>
				<Tq.InputButton
					icon="mdi:connection"
					:label="camera ? cameraConfigs.model.value ?? 'Unknown' : 'Connect'"
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
									<img class="view-photo" :src="currentFrameImage" />
									<img class="view-photo" v-bind="onionskinAttrs" />
									<div
										v-if="viewportPopup?.type === 'progress'"
										class="viewportPopupProgress"
									>
										<div
											class="progress"
											:style="{
												width: `calc(${viewportPopup.progress * 100}% - 4px)`,
											}"
										/>
									</div>
								</div>
							</div>
						</template>
						<template #second> 3D View </template>
					</Tq.PaneSplit>
				</template>
				<template #second>
					<div class="controls">
						<div class="cameraParameters">
							<Tq.ParameterGrid>
								<Tq.ParameterHeading>Camera Control</Tq.ParameterHeading>
								<Tq.Parameter label="F.L." icon="lucide:focus">
									<TethrConfig
										name="focalLength"
										:config="cameraConfigs.focalLength"
									/>
								</Tq.Parameter>
								<Tq.Parameter label="F.D." icon="tabler:frustum">
									<TethrConfig :config="cameraConfigs.focusDistance" />
								</Tq.Parameter>
								<Tq.Parameter label="Apr." icon="ph:aperture">
									<TethrConfig
										name="aperture"
										:config="cameraConfigs.aperture"
									/>
								</Tq.Parameter>
								<Tq.Parameter label="SS" icon="material-symbols:shutter-speed">
									<TethrConfig :config="cameraConfigs.shutterSpeed" />
								</Tq.Parameter>
								<Tq.Parameter label="WB" icon="subway:black-white">
									<TethrConfig
										name="colorTemperature"
										:config="cameraConfigs.colorTemperature"
									/>
								</Tq.Parameter>
								<Tq.Parameter label="ISO" icon="carbon:iso">
									<TethrConfig :config="cameraConfigs.iso" />
								</Tq.Parameter>
								<Tq.ParameterHeading>Viewport</Tq.ParameterHeading>
								<Tq.Parameter
									icon="fluent-emoji-high-contrast:onion"
									label="Onion"
								>
									<Tq.InputNumber
										v-model="project.state.onionskin"
										:max="0"
										:min="-1"
										:step="0.1"
									/>
								</Tq.Parameter>
							</Tq.ParameterGrid>
						</div>
						<div class="timeline">
							<div
								ref="$frameMeasure"
								class="frameMeasure"
								:style="{
									width: `calc(${project.allKomas.value.length} * var(--frame-width))`,
								}"
							/>
							<div class="seekbar" :style="seekbarStyles">
								{{ previewFrame }}
							</div>
							<div class="previewRange" :style="previewRangeStyles" />
							<div
								v-for="(koma, frame) in project.allKomas.value"
								:key="frame"
								class="frame"
							>
								<div class="frame-header tq-font-numeric">{{ frame }}</div>
								<div
									v-if="frame === project.captureFrame.value"
									class="frame-image liveview"
								>
									<Icon icon="material-symbols:photo-camera-outline" />
								</div>
								<div
									v-else-if="koma && koma.shots[0]"
									class="frame-image-wrapper"
									:class="{hasRaw: koma.shots[0].raw}"
								>
									<img
										class="frame-image"
										:src="getObjectURL(koma.shots[0].lv)"
									/>
								</div>
								<div
									v-else
									class="frame-image empty"
									@dblclick="insertCamera(frame)"
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

.viewportPopupProgress
	left 50%
	top 50%
	position absolute
	transform translate(-50%, -50%)
	width 30%
	height var(--tq-input-height)
	border-radius 9999px
	overflow hidden
	border 1px solid var(--tq-color-on-background)
	opacity .5

	.progress
		position absolute
		top 2px
		bottom 2px
		left 2px
		background var(--tq-color-on-background)
		border-radius 9999px
		transition width .5s ease


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
		left 1px
		height var(--header-height)
		width var(--frame-width)
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

		&-wrapper
			position relative

			&.hasRaw:before
				content ''
				display block
				position absolute
				bottom 0
				left 2px
				right 2px
				height 4px
				border-radius 4px
				background var(--tq-color-on-primary)


		&.liveview
			background var(--tq-color-primary-container)

			svg
				margin auto
				transform translate(-2px) // IDK why


		&.empty
			background var(--tq-color-input)
			opacity .2

			&:hover
				background var(--tq-color-input-hover)

		span
			display block
</style>
