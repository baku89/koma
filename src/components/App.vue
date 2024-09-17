<script lang="ts" setup>
import {Icon} from '@iconify/vue/dist/iconify.js'
import {whenever} from '@vueuse/core'
import * as Bndr from 'bndr-js'
import {scalar, vec3, vec4} from 'linearly'
import {initTweeq, useTweeq} from 'tweeq'
import {watch} from 'vue'

import {useCameraStore} from '@/stores/camera'
import {useDmxStore} from '@/stores/dmx'
import {useOscStore} from '@/stores/osc'
import {Shot, useProjectStore} from '@/stores/project'
import {useShootAlertsStore} from '@/stores/shootAlerts'
import {useTimelineStore} from '@/stores/timeline'
import {useTimerStore} from '@/stores/timer'
import {useTrackerStore} from '@/stores/tracker'
import {useViewportStore} from '@/stores/viewport'
import {preventConcurrentExecution} from '@/utils'
import {playSound, resizeBlobImage, speak} from '@/utils'

import CameraControl from './CameraControl.vue'
import CameraTrajectoryVisualizer from './CameraTrajectoryVisualizer'
import DmxControl from './DmxControl.vue'
import MarkerSettings from './MarkerSettings.vue'
import Timeline from './Timeline'
import TitleBar from './TitleBar.vue'
import Viewport from './Viewport'

initTweeq('com.baku89.koma', {
	colorMode: 'dark',
	accentColor: '#C85168',
})

const Tq = useTweeq()
const viewport = useViewportStore()
const timeline = useTimelineStore()
const project = useProjectStore()
const camera = useCameraStore()
const osc = useOscStore()
const dmx = useDmxStore()
const timer = useTimerStore()
const tracker = useTrackerStore()
const shootAlerts = useShootAlertsStore()
const gamepad = Bndr.gamepad()

watch(() => project.captureShot, timer.reset)

//------------------------------------------------------------------------------
Tq.actions.onBeforePerform(action => {
	if (action.id !== 'toggle_play') {
		viewport.isPlaying = false
	}
})

//------------------------------------------------------------------------------
// Shoot

const {fn: shoot} = preventConcurrentExecution(
	async (force = false): Promise<Shot> => {
		if (project.captureShot.frame !== viewport.currentFrame) {
			viewport.setCurrentFrame(project.captureShot.frame)
			viewport.setCurrentLayer(project.captureShot.layer)
			playSound('sound/Onoma-Inspiration04-4(Low).mp3')
			throw new Error('The capture frame is not current frame')
		}

		if (!force && !shootAlerts.canShoot) {
			await playSound('sound/Onoma-Negative07-4(Low-Short).mp3')

			for await (const msg of shootAlerts.alerts) {
				await speak(msg)
			}

			throw new Error('Cannot shoot')
		}

		if (!camera.tethr) {
			await playSound('sound/Onoma-Negative07-4(Low-Short).mp3')

			speak('No camera is connected')

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

			if (camera.focalLength.value) {
				cameraConfigs.focalLength = camera.focalLength.value
			}

			const trackerData = tracker.enabled
				? {position: tracker.position, rotation: tracker.rotation}
				: undefined

			const dmxData = dmx.values.map(v => v.value)

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
			let jpgFilename: string | undefined
			let rawFilename: string | undefined

			if (result.status === 'ok') {
				for (const object of result.value) {
					const format = String(object.format)

					if (/jpe?g/.test(format)) {
						jpg = object.blob
						jpgFilename = object.filename
					} else {
						raw = object.blob
						rawFilename = object.filename
					}
				}
			}

			if (!jpg) throw new Error('No JPEG image found')

			if (new Date().getTime() - captureDate > 500) {
				playSound('sound/Accent36-1.mp3')
			}

			// Resize jpg to fit the resolution of the project
			const lv = await resizeBlobImage(jpg, project.resolution)

			return {
				jpg,
				raw,
				lv,
				jpgFilename,
				rawFilename,
				cameraConfigs,
				shootTime: timer.current,
				captureDate,
				tracker: trackerData,
				dmx: dmxData,
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

const oscIn = osc.receivers({
	shoot: {address: '/shoot', type: 'b', default: 0},
})

whenever(oscIn.shoot, () => Tq.actions.perform('shoot'))

//------------------------------------------------------------------------------

const gamepadAxis = gamepad.axisDirection()

const gamepadAxisNeutral = gamepadAxis.filter(v => v === null)
const gamepadAxisLeft = gamepadAxis.map(v => v && v[0] === -1)
const gamepadAxisRight = gamepadAxis.map(v => v && v[0] === 1)
// const gamepadAxisTop = gamepadAxis.map(v => v && v[1] === -1)
// const gamepadAxisBottom = gamepadAxis.map(v => v && v[1] === 1)

gamepadAxisRight.longPress(500).pressed.on(() => {
	viewport.isPlaying = true
})

gamepadAxisNeutral.on(() => {
	viewport.isPlaying = false
})

Tq.actions.register([
	{
		id: 'file',
		icon: 'mdi:folder',
		children: [
			{
				id: 'create_new',
				icon: 'mdi:file',
				bind: 'command+n',
				async perform() {
					await project.createNew()
					viewport.setCurrentFrame(project.captureShot.frame)
				},
			},
			{
				id: 'open_project',
				label: 'Open Project...',
				icon: 'material-symbols:folder-open-rounded',
				bind: 'command+o',
				async perform() {
					await project.open()
					viewport.setCurrentFrame(project.captureShot.frame)
				},
			},
			{
				id: 'save_project',
				label: 'Save Project',
				icon: 'mdi:content-save',
				bind: 'command+s',
				async perform() {
					if (!project.isSavedToDisk) {
						await project.saveAs()
					} else {
						await project.save()
					}
				},
			},
			{
				id: 'save_project_as',
				label: 'Save Project As...',
				icon: 'mdi:content-save',
				bind: 'command+shift+s',
				async perform() {
					await project.saveAs()
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
				bind: 'command+option+,',
				async perform() {
					const result = await Tq.modal.prompt(
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
							shootCondition: {type: 'string', ui: 'code', lang: 'javascript'},
						},
						{
							title: 'Project Settings',
						}
					)

					if (!result) return

					project.duration = result.duration

					project.$patch(result)
				},
			},
			{
				id: 'preferences',
				icon: 'mdi:settings',
				bind: 'command+,',
				async perform() {
					const result = await Tq.modal.prompt(
						{
							accentColor: Tq.theme.accentColor,
							darkMode: Tq.theme.colorMode === 'dark',
						},
						{
							accentColor: {type: 'string', ui: 'color'},
							darkMode: {type: 'boolean'},
						},
						{
							title: 'Preferences',
						}
					)

					if (!result) return

					Tq.theme.accentColor = result.accentColor
					Tq.theme.colorMode = result.darkMode ? 'dark' : 'light'
				},
			},
		],
	},
	{
		id: 'camera',
		icon: 'mdi:camera',
		children: [
			{
				id: 'nudge_focus_far',
				icon: 'material-symbols:landscape-outline',
				bind: ['2', 'gamepad:y'],
				perform() {
					if (camera.focusDistance.value === null) return
					camera.focusDistance.set(camera.focusDistance.value + 0.005)
				},
			},
			{
				id: 'nudge_focus_near',
				icon: 'tabler:macro',
				bind: ['1', 'gamepad:x'],
				perform() {
					if (camera.focusDistance.value === null) return
					camera.focusDistance.set(camera.focusDistance.value - 0.005)
				},
			},
		],
	},
	{
		id: 'capture',
		icon: 'tabler:capture-filled',
		children: [
			{
				id: 'shoot',
				icon: 'mdi:circle',
				bind: ['enter', 'gamepad:a'],
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

					viewport.setCurrentFrame(project.captureShot.frame)
					viewport.setCurrentLayer(project.captureShot.layer)
				},
			},
			{
				id: 'force-shoot',
				icon: 'mdi:circle',
				bind: ['command+enter'],
				async perform() {
					const newShot = await shoot(true)

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

					viewport.setCurrentFrame(project.captureShot.frame)
					viewport.setCurrentLayer(project.captureShot.layer)
				},
			},
			{
				id: 'shoot_and_next_layer',
				icon: 'mdi:circle',
				bind: ['shift+enter', 'gamepad:+'],
				async perform() {
					const newShot = await shoot()

					project.$patch(state => {
						const {frame, layer} = state.captureShot
						project.setShot(frame, layer, newShot)

						project.captureShot.layer += 1
					})

					viewport.setCurrentFrame(project.captureShot.frame)
					viewport.setCurrentLayer(project.captureShot.layer)
				},
			},
			{
				id: 'set_capture_frame',
				icon: 'mdi:camera',
				bind: ['a', 'gamepad:zr'],
				perform() {
					project.$patch({
						captureShot: {
							frame: viewport.currentFrame,
							layer: viewport.currentLayer,
						},
					})
				},
			},
		],
	},
	{
		id: 'edit',
		icon: 'material-symbols:edit',
		children: [
			{
				id: 'undo',
				icon: 'mdi:undo',
				bind: 'command+z',
				perform() {
					if (!project.history.canUndo) return

					project.undo()
				},
			},
			{
				id: 'redo',
				icon: 'mdi:redo',
				bind: 'command+shift+z',
				perform() {
					if (!project.history.canRedo) return

					project.redo()
				},
			},
		],
	},
	{
		id: 'timeline',
		children: [
			{
				id: 'go_forward_1_frame',
				icon: 'lucide:step-forward',
				bind: ['f', 'right?repeat', gamepadAxisRight.down()],
				perform() {
					viewport.setCurrentFrame(viewport.currentFrame + 1)
					viewport.selectShot()
				},
			},
			{
				id: 'go_backward_1_frame',
				icon: 'lucide:step-back',
				bind: ['d', 'left?repeat', gamepadAxisLeft.down()],
				perform() {
					viewport.setCurrentFrame(viewport.currentFrame - 1)
					viewport.selectShot()
				},
			},
			{
				id: 'increment_current_layer',
				icon: 'mdi:arrow-down',
				bind: ['down' /*, gamepadAxisBottom.down()*/],
				perform() {
					viewport.setCurrentLayer(viewport.currentLayer + 1)
					viewport.selectShot()
				},
			},
			{
				id: 'decrement_current_layer',
				icon: 'mdi:arrow-up',
				bind: ['up' /*, gamepadAxisTop.down()*/],
				perform() {
					viewport.setCurrentLayer(viewport.currentLayer - 1)
					viewport.selectShot()
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
				bind: 'b',
				perform() {
					project.setInPoint(viewport.currentFrame)
				},
			},
			{
				id: 'set_out_point',
				icon: 'mdi:contain-end',
				bind: 'n',
				perform() {
					project.setOutPoint(viewport.currentFrame)
				},
			},
			{
				id: 'export_tracker_targets',
				icon: 'ooui:map-trail',
				perform() {
					const trackers = project.previewKomas.flatMap((koma, frame) => {
						const tracker = koma.shots[0]?.tracker

						frame += project.previewRange[0]

						if (tracker) return tracker ? [{frame, ...tracker}] : []
					})

					const blob = new Blob([JSON.stringify(trackers, null, 2)], {
						type: 'application/json',
					})

					const url = URL.createObjectURL(blob)
					const link = document.createElement('a')
					link.download = 'tracker_targets.json'
					link.href = url
					link.click()
				},
			},
			{
				id: 'clear_tracker_targets',
				icon: 'ooui:map-trail',
				perform() {
					project.$patch(draft => {
						for (const koma of draft.komas) {
							if (koma) {
								koma.target = {...(koma.target ?? {}), tracker: undefined}
							}
						}
					})
				},
			},
			{
				id: 'import_tracker_targets',
				icon: 'ooui:map-trail',
				async perform() {
					const [fileHandle] = await window.showOpenFilePicker()

					// ファイルを読み取る
					const file = await fileHandle.getFile()
					const content = await file.text()

					// JSONをパース
					const data: {frame: number; position: vec3; rotation: vec4}[] =
						JSON.parse(content)

					project.$patch(draft => {
						for (const {frame, position, rotation} of data) {
							let koma = draft.komas[frame]
							if (!koma) {
								koma = {shots: []}
							}
							koma.target = {
								...(koma.target ?? {}),
								tracker: {position, rotation},
							}
						}
					})
				},
			},
		],
	},
	{
		id: 'viewport',
		icon: 'mdi:frame',
		children: [
			{
				id: 'onion_increase',
				icon: 'fluent-emoji-high-contrast:onion',
				bind: ['gamepad:rsr'],
				perform() {
					const onionskin = scalar.clamp(project.onionskin + 0.5, -3, 0)
					project.$patch({onionskin})
				},
			},
			{
				id: 'onion_decrease',
				icon: 'fluent-emoji-high-contrast:onion',
				bind: ['gamepad:rsl'],
				perform() {
					const onionskin = scalar.clamp(project.onionskin - 0.5, -3, 0)
					project.$patch({onionskin})
				},
			},
			{
				id: 'toggle_onionskin',
				icon: 'fluent-emoji-high-contrast:onion',
				bind: ['gamepad:r'],
				perform() {
					viewport.enableOnionskin = !viewport.enableOnionskin
				},
			},
		],
	},
	{
		id: 'playback',
		icon: 'mdi:animation-play',
		children: [
			{
				id: 'toggle_play',
				icon: 'mdi:play',
				bind: ['space'],
				perform() {
					viewport.isPlaying = !viewport.isPlaying
				},
			},
			{
				id: 'toggle_loop',
				icon: 'material-symbols:laps',
				bind: 'l',
				perform() {
					project.isLooping = !project.isLooping
				},
			},
		],
	},
])
</script>

<template>
	<div class="App">
		<Tq.CommandPalette />
		<Tq.PaneModalComplex />
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
									<Tq.Parameter label="Tool">
										<Tq.InputRadio
											v-model="timeline.currentTool"
											:options="['select', 'marker', 'pencil', 'eraser']"
										>
											<template #option="{value}">
												<Icon
													:icon="
														value === 'select'
															? 'ph:cursor-fill'
															: value === 'marker'
																? 'subway:mark'
																: value === 'pencil'
																	? 'mdi:pencil'
																	: 'mdi:eraser'
													"
												/>
											</template>
										</Tq.InputRadio>
									</Tq.Parameter>
									<CameraControl />
									<DmxControl />
									<Tq.ParameterGroup label="Viewport" name="viewportSettings">
										<Tq.Parameter
											icon="fluent-emoji-high-contrast:onion"
											label="Onion"
										>
											<Tq.InputNumber
												v-model="project.onionskin"
												:max="0"
												:min="-3"
												:step="0.1"
											/>
										</Tq.Parameter>
										<Tq.Parameter label="Traj. Ave." icon="ooui:map-trail">
											<Tq.InputNumber
												v-model="tracker.averageSamples"
												:min="0"
												:max="3"
												:step="1"
											/>
										</Tq.Parameter>
										<Tq.Parameter label="Zoom" icon="material-symbols:zoom-in">
											<Tq.InputNumber
												v-model="project.viewport.zoom"
												:min="1"
												:max="1.5"
												:step="0.05"
											/>
										</Tq.Parameter>
									</Tq.ParameterGroup>
									<MarkerSettings />
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
