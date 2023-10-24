<script lang="ts" setup>
import {Bndr} from 'bndr-js'
import {scalar} from 'linearly'
import Tq, {useTweeq} from 'tweeq'
import {useActionsStore} from 'tweeq'
import {ref, watch} from 'vue'

import {playSound} from '@/playSound'
import {useCameraStore} from '@/stores/camera'
import {Shot, useProjectStore} from '@/stores/project'
import {useShootAlertsStore} from '@/stores/shootAlerts'
import {useTimerStore} from '@/stores/timer'
import {useTrackerStore} from '@/stores/tracker'
import {useViewportStore} from '@/stores/viewport'
import {preventConcurrentExecution} from '@/util'

import CameraControl from './CameraControl.vue'
import CameraTrajectoryVisualizer from './CameraTrajectoryVisualizer'
import Timeline from './Timeline.vue'
import TitleBar from './TitleBar.vue'
import Viewport from './Viewport.vue'

useTweeq('com.baku89.koma', {
	colorMode: 'dark',
	accentColor: '#ff0000',
})

const actions = useActionsStore()

const viewport = useViewportStore()
const project = useProjectStore()
const camera = useCameraStore()
const timer = useTimerStore()
const tracker = useTrackerStore()
const shootAlerts = useShootAlertsStore()

const $modal = ref<typeof Tq.PaneModalComplex | null>(null)

Bndr.or(Bndr.keyboard().pressed('5'), Bndr.gamepad().button('x')).on(
	pressed => {
		viewport.liveToggle = pressed
	}
)

watch(() => project.captureShot, timer.reset)

//------------------------------------------------------------------------------
actions.onBeforePerform(action => {
	if (action.id !== 'toggle_play') {
		viewport.isPlaying = false
	}
})

//------------------------------------------------------------------------------
// Shoot

const {fn: shoot} = preventConcurrentExecution(
	async (): Promise<Shot> => {
		if (!shootAlerts.canShoot) {
			playSound('sound/Onoma-Negative07-4(Low-Short).mp3')
			throw new Error('Cannot shoot')
		}

		if (!camera.tethr) {
			throw new Error('No camera is coonnected')
		}

		const {tethr} = camera

		try {
			viewport.popup = {
				type: 'progress',
				progress: 0,
			}

			playSound('sound/Camera-Phone03-1.mp3')
			const captureDate = new Date().getTime()

			const cameraConfigs = await tethr.exportConfigs()

			const trackerData = tracker.enabled
				? {position: tracker.position, rotation: tracker.rotation}
				: undefined

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

			if (!jpg) throw new Error('No JPEG image found')

			if (new Date().getTime() - captureDate > 500) {
				playSound('sound/Accent36-1.mp3')
			}

			return {
				jpg,
				raw,
				lv: lv.value,
				cameraConfigs,
				shootTime: timer.current,
				captureDate,
				tracker: trackerData,
			}
		} finally {
			viewport.popup = null
		}
	},
	() => {
		playSound('sound/Onoma-Negative07-4(Low-Short).mp3')
		throw new Error('The Shooting is already executed')
	}
)

//------------------------------------------------------------------------------
actions.register([
	{
		id: 'create_new',
		icon: 'mdi:file',
		input: 'command+n',
		async perform() {
			await project.createNew()
			viewport.currentFrame = project.captureShot.frame
		},
	},
	{
		id: 'open_project',
		label: 'Open Project...',
		icon: 'material-symbols:folder-open-rounded',
		input: 'command+o',
		async perform() {
			await project.open()
			viewport.currentFrame = project.captureShot.frame
		},
	},
	{
		id: 'save_project_as',
		label: 'Save Project As...',
		icon: 'mdi:content-save',
		input: 'command+shift+s',
		async perform() {
			await project.saveAs()
		},
	},
	{
		id: 'save_project_in_opfs',
		label: 'Save Project in OPFS',
		icon: 'octicon:cache-16',
		async perform() {
			await project.saveInOpfs()
		},
	},
	{
		id: 'shoot',
		icon: 'mdi:circle',
		input: ['enter', 'gamepad:a'],
		async perform() {
			const newShot = await shoot()

			project.$patch(state => {
				const {frame, layer} = state.captureShot
				project.setShot(frame, layer, newShot)

				// Find next empty frame
				for (let i = frame + 1; i <= state.komas.length; i++) {
					if (!state.komas[i] || !state.komas[i]?.shots[0]) {
						state.captureShot = {frame: i, layer: 0}
						break
					}
				}

				state.previewRange[1] = state.captureShot.frame
			})

			viewport.currentFrame = project.captureShot.frame
		},
	},
	{
		id: 'nudge_focus_far',
		icon: 'material-symbols:landscape-outline',
		input: ['2', 'gamepad:zr'],
		perform() {
			if (camera.focusDistance.value === null) return
			camera.focusDistance.set(camera.focusDistance.value + 0.01)
		},
	},
	{
		id: 'nudge_focus_near',
		icon: 'tabler:macro',
		input: ['1', 'gamepad:zl'],
		perform() {
			if (camera.focusDistance.value === null) return
			camera.focusDistance.set(camera.focusDistance.value - 0.01)
		},
	},
	{
		id: 'onion_increase',
		icon: 'fluent-emoji-high-contrast:onion',
		input: ['gamepad:r'],
		perform() {
			project.$patch({onionskin: project.onionskin + 0.1})
		},
	},
	{
		id: 'onion_decrease',
		icon: 'fluent-emoji-high-contrast:onion',
		input: ['gamepad:l'],
		perform() {
			project.$patch({onionskin: project.onionskin - 0.1})
		},
	},
	{
		id: 'undo',
		icon: 'mdi:undo',
		input: 'command+z',
		perform() {
			project.undo()
			viewport.currentFrame = project.captureShot.frame
		},
	},
	{
		id: 'redo',
		icon: 'mdi:redo',
		input: 'command+shift+z',
		perform() {
			project.redo()
			viewport.currentFrame = project.captureShot.frame
		},
	},
	{
		id: 'go_forward_1_frame',
		icon: 'lucide:step-forward',
		input: ['f', 'right', 'gamepad:right'],
		perform() {
			viewport.currentFrame += 1
		},
	},
	{
		id: 'go_backward_1_frame',
		icon: 'lucide:step-back',
		input: ['d', 'left', 'gamepad:left'],
		perform() {
			viewport.currentFrame = Math.max(0, viewport.currentFrame - 1)
		},
	},
	{
		id: 'delete_current_frame',
		icon: 'mdi:backspace',
		input: ['delete', 'backspace', 'gamepad:b'],
		perform() {
			const isDeletingCaptureFrame =
				viewport.currentFrame === project.captureShot.frame

			const frameToDelete = isDeletingCaptureFrame
				? viewport.currentFrame - 1
				: viewport.currentFrame

			if (frameToDelete < 0 || project.duration <= frameToDelete) {
				return
			}

			project.$patch(project => {
				project.komas.splice(frameToDelete, 1)
				if (
					isDeletingCaptureFrame &&
					viewport.currentFrame === project.captureShot.frame
				) {
					viewport.currentFrame -= 1
				}
				if (frameToDelete < project.captureShot.frame) {
					project.captureShot.frame -= 1
				}
				if (frameToDelete <= project.previewRange[1]) {
					project.previewRange[1] -= 1
				}
			})
			playSound('sound/Hit08-1.mp3')
		},
	},
	{
		id: 'insert_camera',
		icon: 'mdi:camera-plus',
		perform() {
			project.captureShot.frame = viewport.currentFrame
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
		input: ['space', 'gamepad:y'],
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
	{
		id: 'import_audio',
		icon: 'material-symbols:audio-file',
		async perform() {
			const files = await window.showOpenFilePicker({
				types: [
					{
						description: 'Audio Files',
						accept: {'audio/*': ['.wav']},
					},
				],
			})

			const src = await files[0].getFile()

			project.$patch({audio: {src, startFrame: 0}})
		},
	},
	{
		id: 'project_settings',
		icon: 'mdi:gear',
		input: 'command+,',
		async perform() {
			const result = await $modal.value!.prompt(
				{
					name: project.name,
					fps: project.fps,
					duration: project.duration,
					shootCondition: project.shootCondition,
				},
				{
					name: {type: 'string'},
					fps: {type: 'number', min: 1, max: 60, step: 1},
					duration: {type: 'number', min: 0, step: 1},
					shootCondition: {type: 'code', lang: 'javascript'},
				},
				{
					title: 'Project Settings',
				}
			)

			project.duration = result.duration

			delete result.duration
			project.$patch(result)
		},
	},
])
</script>

<template>
	<div class="App">
		<Tq.CommandPalette />
		<Tq.PaneModalComplex ref="$modal" />
		<TitleBar />
		<main class="main">
			<Tq.PaneSplit name="vertical" direction="vertical">
				<template #first>
					<Tq.PaneSplit
						name="preview"
						direction="horizontal"
						:scroll="[false, false]"
					>
						<template #first>
							<Viewport class="viewport" />
						</template>
						<template #second>
							<CameraTrajectoryVisualizer />
						</template>
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
								</Tq.ParameterGrid>
							</div>
						</template>
						<template #second>
							<Timeline class="timeline" />
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
	padding var(--tq-pane-padding) calc(var(--tq-pane-padding) - var(--tq-scrollbar-width)) var(--tq-pane-padding) var(--tq-pane-padding)

.timeline
	padding-top var(--tq-pane-padding)
	padding-left var(--tq-pane-padding)
	width 100%
	height 100%
</style>
