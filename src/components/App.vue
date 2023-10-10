<script lang="ts" setup>
import {Icon} from '@iconify/vue'
import {useEventListener} from '@vueuse/core'
import {Bndr} from 'bndr-js'
import {produce} from 'immer'
import {scalar} from 'linearly'
import Tq, {useTweeq} from 'tweeq'
import {computed, ref, shallowRef} from 'vue'

import {playSound} from '@/playSound'
import {useCameraStore} from '@/stores/camera'
import {getObjectURL, Shot, useProjectState} from '@/stores/project'
import {useViewportStore} from '@/stores/viewport'
import {useBndr} from '@/use/useBndr'

import TethrConfig from './TethrConfig.vue'

const {registerActions, onBeforeActionPerform} = useTweeq('com.baku89.koma', {
	colorMode: 'dark',
	accentColor: '#ff0000',
})

const viewport = useViewportStore()
const project = useProjectState()
const camera = useCameraStore()

Bndr.or(Bndr.keyboard().pressed('5'), Bndr.gamepad().button('x')).on(
	pressed => {
		viewport.liveToggle = pressed
	}
)

//------------------------------------------------------------------------------
// Connection

const isGamepadConnected = ref(false)

Bndr.gamepad()
	.connected()
	.on(connected => {
		isGamepadConnected.value = connected
	})

//------------------------------------------------------------------------------
// Viewport popup

type ViewportPopup = null | {type: 'progress'; progress: number}

const viewportPopup = shallowRef<ViewportPopup>(null)

//------------------------------------------------------------------------------
// Playing

onBeforeActionPerform(action => {
	if (action.id !== 'toggle_play') {
		viewport.isPlaying = false
	}
})

useEventListener(window, 'beforeunload', e => {
	if (project.hasModified) {
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
			viewport.currentFrame = frame
		})
})

function insertCamera(frame: number) {
	viewport.currentFrame = frame
	project.data = produce(project.data, draft => {
		draft.captureFrame = viewport.currentFrame
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
			viewport.currentFrame = project.data.captureFrame
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
			if (!camera.tethr) return

			const {tethr} = camera

			try {
				viewportPopup.value = {
					type: 'progress',
					progress: 0,
				}

				playSound('sound/Camera-Phone03-1.mp3')
				const timeStart = new Date().getTime()

				const lv = await tethr.getLiveViewImage()
				if (lv.status !== 'ok') throw new Error('Failed to get liveview image')

				viewportPopup.value = {
					type: 'progress',
					progress: 0.1,
				}

				const onProgress = ({progress}: {progress: number}) => {
					viewportPopup.value = {
						type: 'progress',
						progress: scalar.lerp(0.1, 1, progress),
					}
				}
				tethr.on('progress', onProgress)

				const result = await tethr.takePhoto()

				tethr.off('progress', onProgress)

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

				project.data = produce(project.data, draft => {
					const shot: Shot = {
						jpg,
						raw,
						lv: lv.value,
						cameraConfigs: {},
					}

					const koma = draft.komas[viewport.currentFrame]

					if (koma) {
						// If there is already a shot, replace it
						koma.shots[0] = shot
					} else {
						// Otherwise, create a new frame
						draft.komas[viewport.currentFrame] = {
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

				viewport.currentFrame = project.captureFrame
				project.setOutPoint(project.captureFrame)

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
			viewport.currentFrame = project.captureFrame
		},
	},
	{
		id: 'redo',
		icon: 'mdi:redo',
		input: 'command+shift+z',
		perform() {
			project.history.redo()
			viewport.currentFrame = project.captureFrame
		},
	},
	{
		id: 'go_forward_1_frame',
		icon: 'lucide:step-forward',
		input: ['f', 'right'],
		perform() {
			viewport.currentFrame += 1
		},
	},
	{
		id: 'go_backward_1_frame',
		icon: 'lucide:step-back',
		input: ['d', 'left'],
		perform() {
			viewport.currentFrame = Math.max(0, viewport.currentFrame - 1)
		},
	},
	{
		id: 'delete_current_frame',
		icon: 'mdi:backspace',
		input: ['delete', 'backspace', 'gamepad:home'],
		perform() {
			project.data = produce(project.data, draft => {
				draft.komas.splice(viewport.currentFrame, 1)
				if (viewport.currentFrame < draft.captureFrame) {
					draft.captureFrame -= 1
				}
			})
			project.setInPoint(project.state.previewRange[0])
			project.setOutPoint(project.state.previewRange[1])
			playSound('sound/Hit08-1.mp3')
		},
	},
	{
		id: 'insert_camera',
		icon: 'mdi:camera-plus',
		perform() {
			project.data = produce(project.data, draft => {
				draft.captureFrame = viewport.currentFrame
			})
		},
	},
	{
		id: 'set_in_point',
		icon: 'mdi:contain-start',
		input: 'b',
		perform() {
			project.setInPoint(viewport.currentFrame)
		},
	},
	{
		id: 'set_out_point',
		icon: 'mdi:contain-end',
		input: 'n',
		perform() {
			project.setOutPoint(viewport.currentFrame)
		},
	},
	{
		id: 'toggle_play',
		icon: 'mdi:play',
		input: 'space',
		perform() {
			viewport.isPlaying = !viewport.isPlaying
		},
	},
	{
		id: 'toggle_loop',
		icon: 'material-symbols:laps',
		input: 'l',
		perform() {
			viewport.isLooping = !viewport.isLooping
		},
	},
])

const seekbarStyles = computed(() => {
	return {
		transform: `translateX(calc(${viewport.previewFrame} * var(--koma-width)))`,
	}
})

const previewRangeStyles = computed(() => {
	const [inPoint, outPoint] = project.state.previewRange
	return {
		transform: `translateX(calc(${inPoint} * var(--koma-width)))`,
		width: `calc(${outPoint - inPoint + 1} * var(--koma-width) + 1px)`,
	}
})

const transparent =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const currentFrameImage = computed(() => {
	const frame = project.data.komas[viewport.previewFrame]?.shots[0]
	if (viewport.isLiveview || !frame) {
		return transparent
	}

	return getObjectURL(viewport.enableHiRes ? frame.jpg : frame.lv)
})

const onionskinAttrs = computed(() => {
	const {onionskin} = project.state

	const delta = onionskin < 0 ? -1 : 1
	const frame = project.data.komas[viewport.previewFrame + delta]?.shots[0]
	if (!frame) {
		return {
			style: {display: 'none'},
		}
	}

	const opacity = onionskin % 1 === 0 ? 1 : Math.abs(onionskin) % 1

	return {
		src: getObjectURL(viewport.enableHiRes ? frame.jpg : frame.lv),
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
					:modelValue="project.data.name"
					style="width: 10em"
					@focus="project.pauseHistory()"
					@blur="project.pushHistory()"
					@update:modelValue="project.data = {...project.data, name: $event}"
				/>
			</template>
			<template #center>
				<Tq.InputNumber
					:modelValue="viewport.previewFrame"
					:precision="0"
					:min="0"
					:max="project.allKomas.length - 1"
					:step="1"
					:bar="false"
					suffix=" F"
					style="width: 5em"
					@update:modelValue="viewport.currentFrame = $event"
				/>
				<Tq.InputIconToggle
					v-model="viewport.isLooping"
					icon="material-symbols:laps"
				/>
				<Tq.InputIconToggle
					v-model="viewport.isPlaying"
					:icon="viewport.isPlaying ? 'mdi:pause' : 'mdi:play'"
				/>
				<Tq.InputIconToggle
					v-model="viewport.enableHiRes"
					icon="mdi:high-definition"
				/>
			</template>
			<template #right>
				<Tq.InputButton
					icon="mdi:connection"
					:label="camera.model.value ?? 'Connect'"
					@click="camera.toggleConnection"
				/>
				<Tq.IconIndicator
					:modelValue="isGamepadConnected"
					icon="solar:gamepad-bold"
				/>
			</template>
		</Tq.TitleBar>
		<main class="main">
			<Tq.PaneSplit name="timeline" direction="vertical">
				<template #first>
					<Tq.PaneSplit name="preview" direction="horizontal">
						<template #first>
							<div class="view">
								<div
									class="view-image-wrapper"
									:class="{liveview: viewport.isLiveview}"
								>
									<video
										class="view-video"
										:style="{
											visibility: viewport.isLiveview ? 'visible' : 'hidden',
										}"
										:srcObject.prop="camera.liveviewMediaStream"
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
								<Tq.Parameter label="Exp." icon="material-symbols:exposure">
									<TethrConfig :config="camera.exposureComp" />
								</Tq.Parameter>
								<Tq.Parameter label="F.L." icon="lucide:focus">
									<TethrConfig
										:config="camera.focalLength"
										name="focalLength"
									/>
								</Tq.Parameter>
								<Tq.Parameter label="F.D." icon="tabler:frustum">
									<TethrConfig
										:config="camera.focusDistance"
										name="focusDistance"
									/>
								</Tq.Parameter>
								<Tq.Parameter label="Apr." icon="ph:aperture">
									<TethrConfig :config="camera.aperture" name="aperture" />
								</Tq.Parameter>
								<Tq.Parameter label="SS" icon="material-symbols:shutter-speed">
									<TethrConfig
										:config="camera.shutterSpeed"
										name="shutterSpeed"
									/>
								</Tq.Parameter>
								<Tq.Parameter label="WB" icon="subway:black-white">
									<TethrConfig
										:config="camera.whiteBalance"
										name="whiteBalance"
									/>
								</Tq.Parameter>
								<Tq.Parameter label="C.Temp" icon="mdi:temperature">
									<TethrConfig
										:config="camera.colorTemperature"
										name="colorTemperature"
									/>
								</Tq.Parameter>
								<Tq.Parameter label="ISO" icon="carbon:iso">
									<TethrConfig :config="camera.iso" />
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
								<Tq.Parameter icon="material-symbols:width" label="Zoom">
									<Tq.InputNumber
										:modelValue="project.state.timeline.komaWidth * 100"
										:min="20"
										:max="200"
										suffix="%"
										:barOrigin="100"
										:step="1"
										@update:modelValue="
											project.state.timeline.komaWidth = $event / 100
										"
									/>
								</Tq.Parameter>
							</Tq.ParameterGrid>
						</div>
						<div
							class="timeline"
							:style="{
								'--koma-width': project.state.timeline.komaWidth * 80 + 'px',
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
							>
								<div class="koma-header tq-font-numeric">{{ frame }}</div>
								<div class="shot">
									<div v-if="frame === project.captureFrame" class="liveview">
										<Icon icon="material-symbols:photo-camera-outline" />
									</div>
									<div
										v-else-if="koma && koma.shots[0]"
										class="captured"
										:class="{hasRaw: koma.shots[0].raw}"
									>
										<img :src="getObjectURL(koma.shots[0].lv)" />
									</div>
									<div v-else class="empty" @dblclick="insertCamera(frame)" />
									<div class="in-between" />
								</div>
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
		width 6px
		right -3px
		// background blue
</style>
../../dev_modules/tweeq/demo/src ../../dev_modules/tweeq/src @/stores/project
@/stores/useTethr
