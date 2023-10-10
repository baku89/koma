<script lang="ts" setup>
import {Bndr} from 'bndr-js'
import {scalar} from 'linearly'
import Tq, {useTweeq} from 'tweeq'
import {useActionsStore} from 'tweeq'
import {ref} from 'vue'

import {playSound} from '@/playSound'
import {useCameraStore} from '@/stores/camera'
import {Shot, useProjectStore} from '@/stores/project'
import {useViewportStore} from '@/stores/viewport'

import CameraControl from './CameraControl.vue'
import Timeline from './Timeline.vue'
import Viewport from './Viewport.vue'

useTweeq('com.baku89.koma', {
	colorMode: 'dark',
	accentColor: '#ff0000',
})

const actions = useActionsStore()

const viewport = useViewportStore()
const project = useProjectStore()
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

//------------------------------------------------------------------------------
actions.onBeforePerform(action => {
	if (action.id !== 'toggle_play') {
		viewport.isPlaying = false
	}
})

//------------------------------------------------------------------------------
actions.register([
	{
		id: 'create_new',
		icon: 'mdi:file',
		input: 'command+n',
		async perform() {
			await project.createNew()
			viewport.currentFrame = project.captureFrame
		},
	},
	{
		id: 'open_project',
		icon: 'material-symbols:folder-open-rounded',
		menu: '',
		input: 'command+o',
		async perform() {
			await project.open()
			viewport.currentFrame = project.captureFrame
		},
	},
	{
		id: 'save_project',
		icon: 'mdi:content-save',
		input: 'command+shift+s',
		menu: '',
		async perform() {
			await project.saveAs()
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
				viewport.popup = {
					type: 'progress',
					progress: 0,
				}

				playSound('sound/Camera-Phone03-1.mp3')
				const timeStart = new Date().getTime()

				const cameraConfigs = await tethr.exportConfigs()

				const lv = await tethr.getLiveViewImage()
				if (lv.status !== 'ok') throw new Error('Failed to get liveview image')

				viewport.popup = {
					type: 'progress',
					progress: 0.1,
				}

				const onProgress = ({progress}: {progress: number}) => {
					viewport.popup = {
						type: 'progress',
						progress: scalar.lerp(0.1, 1, progress),
					}
				}
				tethr.on('progress', onProgress)

				const result = await tethr.takePhoto()

				tethr.off('progress', onProgress)

				let jpg: Blob | undefined
				let raw: Blob | undefined

				if (result.status === 'ok') {
					for (const object of result.value) {
						const format = String(object.format)

						if (/jpe?g/.test(format)) {
							jpg = object.blob
						} else {
							raw = object.blob
						}
					}
				}

				if (!jpg) return

				const shot: Shot = {
					jpg,
					raw,
					lv: lv.value,
					cameraConfigs,
				}

				project.$patch(state => {
					const f = state.captureFrame
					const koma = state.komas[f]

					if (koma) {
						// If there is already a shot, replace it
						koma.shots[0] = shot
					} else {
						// Otherwise, create a new frame
						state.komas[f] = {
							shots: [shot],
							backupShots: [],
						}
					}

					// Find next empty frame
					for (let i = state.captureFrame + 1; i <= state.komas.length; i++) {
						if (!state.komas[i]) {
							state.captureFrame = i
							break
						}
					}

					project.previewRange[1] = state.captureFrame
				})

				viewport.currentFrame = project.captureFrame

				if (new Date().getTime() - timeStart > 500) {
					playSound('sound/Accent36-1.mp3')
				}
			} finally {
				viewport.popup = null
			}
		},
	},
	{
		id: 'undo',
		icon: 'mdi:undo',
		input: 'command+z',
		perform() {
			project.undo()
			viewport.currentFrame = project.captureFrame
		},
	},
	{
		id: 'redo',
		icon: 'mdi:redo',
		input: 'command+shift+z',
		perform() {
			project.redo()
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
			project.$patch(state => {
				state.komas.splice(viewport.currentFrame, 1)
				if (viewport.currentFrame < state.captureFrame) {
					state.captureFrame -= 1
				}
				project.previewRange[1] = Math.min(
					project.previewRange[1],
					project.allKomas.length - 1
				)
			})
			playSound('sound/Hit08-1.mp3')
		},
	},
	{
		id: 'insert_camera',
		icon: 'mdi:camera-plus',
		perform() {
			project.captureFrame = viewport.currentFrame
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
			project.isLooping = !project.isLooping
		},
	},
])
</script>

<template>
	<div class="App">
		<Tq.CommandPalette />
		<Tq.TitleBar name="Koma" class="title" icon="favicon.svg">
			<template #left>
				<Tq.InputString v-model="project.name" style="width: 10em" />
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
					v-model="project.isLooping"
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
			<Tq.PaneSplit name="vertical" direction="vertical">
				<template #first>
					<Tq.PaneSplit name="preview" direction="horizontal">
						<template #first>
							<Viewport class="viewport" />
						</template>
						<template #second> 3D View </template>
					</Tq.PaneSplit>
				</template>
				<template #second>
					<Tq.PaneSplit name="bottom" direction="horizontal">
						<template #first>
							<div class="control">
								<Tq.ParameterGrid>
									<CameraControl />
									<Tq.ParameterHeading>Viewport</Tq.ParameterHeading>
									<Tq.Parameter
										icon="fluent-emoji-high-contrast:onion"
										label="Onion"
									>
										<Tq.InputNumber
											v-model="project.onionskin"
											:max="1"
											:min="-1"
											:step="0.1"
										/>
									</Tq.Parameter>
									<Tq.Parameter icon="material-symbols:width" label="Zoom">
										<Tq.InputNumber
											:modelValue="project.timeline.zoomFactor * 100"
											:min="20"
											:max="200"
											suffix="%"
											:barOrigin="100"
											:step="1"
											@update:modelValue="
												project.timeline.zoomFactor = $event / 100
											"
										/>
									</Tq.Parameter>
								</Tq.ParameterGrid>
							</div>
						</template>
						<template #second>
							<div class="timeline">
								<Timeline />
							</div>
						</template>
					</Tq.PaneSplit>
				</template>
			</Tq.PaneSplit>
		</main>
	</div>
</template>

<style lang="stylus" scoped>
.main
	position fixed
	inset var(--app-margin-top) 0 0

.viewport
	width 100%
	height 100%

.control
	padding var(--tq-pane-padding)

.timeline
	padding-top var(--tq-pane-padding)
	width 100%
	height 100%
</style>
