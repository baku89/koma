<script lang="ts" setup>
import {useEventListener, whenever} from '@vueuse/core'
import * as Bndr from 'bndr-js'
import {scalar, vec2, vec3, vec4} from 'linearly'
import sleep from 'p-sleep'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import saferEval from 'safer-eval'
import {initTweeq, useTweeq} from 'tweeq'
import {markRaw, watch, watchEffect} from 'vue'

import {useCameraStore} from '@/stores/camera'
import {useCncStore} from '@/stores/cnc'
import {useDmxStore} from '@/stores/dmx'
import {useOscStore} from '@/stores/osc'
import {Shot, useProjectStore} from '@/stores/project'
import {useShootAlertsStore} from '@/stores/shootAlerts'
import {useTimelineStore} from '@/stores/timeline'
import {useTimerStore} from '@/stores/timer'
import {useTrackerStore} from '@/stores/tracker'
import {useViewportStore} from '@/stores/viewport'
import {preventConcurrentExecution} from '@/utils'
import {
	frameAssetFilename,
	playSound,
	registerCapturedAsset,
	resizeBlobImage,
	speak,
} from '@/utils'

import CameraControl from './CameraControl.vue'
import CameraTrajectoryVisualizer from './CameraTrajectoryVisualizer'
import DmxControl from './DmxControl.vue'
import InAppProjectsPanel from './InAppProjectsPanel.vue'
import MarkerSettings from './MarkerSettings.vue'
import Preview from './Preview'
import Timeline from './Timeline'
import TitleBar from './TitleBar.vue'

initTweeq('com.baku89.koma', {
	colorMode: 'dark',
	accentColor: '#C85168',
})

const Tq = useTweeq()
const viewport = useViewportStore()
const timeline = useTimelineStore()
const project = useProjectStore()
const camera = useCameraStore()
const cnc = useCncStore()
const osc = useOscStore()
const dmx = useDmxStore()
const timer = useTimerStore()
const tracker = useTrackerStore()
const shootAlerts = useShootAlertsStore()

// Warn before unload if a save is in flight (e.g. re-sequencing files on disk
// after a frame edit) or there are still-unsaved changes — interrupting a
// re-sequence can leave the folder half-renamed.
useEventListener(window, 'beforeunload', (e: BeforeUnloadEvent) => {
	if (project.isSaving || project.dirty) {
		e.preventDefault()
		e.returnValue = ''
	}
})

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

type PreShootFn = (context: {
	cnc: ReturnType<typeof useCncStore>
	project: ReturnType<typeof useProjectStore>
	viewport: ReturnType<typeof useViewportStore>
	camera: ReturnType<typeof useCameraStore>
	tracker: ReturnType<typeof useTrackerStore>
	sleep: (ms: number) => Promise<void>
	readProjectFile: (filename: string) => Promise<string>
	queueMicrotask: typeof queueMicrotask
}) => unknown | Promise<unknown>

/**
 * Runs the user-defined pre-shoot script and awaits whatever Promise it
 * returns. Capture proceeds as soon as that resolves, regardless of whether any
 * CNC motion the script started has finished — so a long exposure can begin
 * while the rod is still travelling (e.g. drawing an LED light streak).
 *
 * If the script throws or the returned Promise rejects (e.g. the CNC is not
 * connected, or the per-frame G-code file is missing), the rejection
 * propagates and the shot is treated as a failure.
 */
function makeScriptContext() {
	return {
		cnc,
		project,
		viewport,
		camera,
		tracker,
		sleep,
		readProjectFile: project.readProjectFile,
		queueMicrotask,
	}
}

/**
 * Compiles a script field into its (async) function. safer-eval evaluates the
 * code as `return <code>`, so a leading `;` (the IIFE-guard idiom kept in the
 * default templates) would turn into `return;` and yield `undefined` — strip it
 * and fail loudly if the result isn't a function.
 */
function compileScript(code: string): PreShootFn {
	const src = code.trim().replace(/^;+\s*/, '')
	const fn = saferEval(src, {vec3}) as unknown
	if (typeof fn !== 'function') {
		throw new Error('Script must evaluate to a function')
	}
	return fn as PreShootFn
}

async function runPreShoot() {
	if (!project.preShootScript?.trim()) return

	const fn = compileScript(project.preShootScript)

	await fn(makeScriptContext())
}

/**
 * Runs the user-defined custom script (Project Settings → Custom Script) on
 * demand from the Command Palette. Same context as the pre-shoot script, but a
 * failure here just notifies — it doesn't affect any shot.
 */
async function runCustomScript() {
	if (!project.customScript?.trim()) {
		speak('No custom script is set')
		return
	}

	try {
		const fn = compileScript(project.customScript)
		await fn(makeScriptContext())
	} catch (e) {
		await playSound('sound/Onoma-Negative07-4(Low-Short).mp3')
		speak('Custom script failed')
		// eslint-disable-next-line no-console
		console.error('[customScript] failed', e)
	}
}

const {fn: shoot} = preventConcurrentExecution(
	async (force = false): Promise<Shot> => {
		if (project.captureShot.frame !== viewport.currentFrame) {
			viewport.setCurrentFrame(project.captureShot.frame)
			viewport.setCurrentLayer(project.captureShot.layer)
			playSound('sound/Onoma-Inspiration04-4(Low).mp3')
			throw new Error('The capture frame is not current frame')
		}

		if (!force && !shootAlerts.canShoot) {
			// Re-reveal the alert pane (it may have been collapsed) so the reason
			// the shutter refused is shown.
			shootAlerts.requestReveal()

			await playSound('sound/Onoma-Negative07-4(Low-Short).mp3')

			for (const msg of shootAlerts.alerts) {
				speak(msg)
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

			// Run the pre-shoot script and wait for the Promise it returns, then
			// open the shutter immediately. Any CNC motion it left running keeps
			// drawing into the exposure. A rejection here fails the shot.
			try {
				await runPreShoot()
			} catch (e) {
				await playSound('sound/Onoma-Negative07-4(Low-Short).mp3')
				speak('Pre shoot script failed')
				throw e instanceof Error
					? e
					: new Error('Pre shoot script failed: ' + String(e))
			}

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
			const lv = await resizeBlobImage(jpg, project.resolution, 'cover')

			// Register the captured bytes as session assets and store only their
			// ids on the shot. The initial filename is derived from the capture
			// slot; bytes are persisted on the next autosave.
			const {frame, layer} = project.captureShot
			const name = project.name

			return {
				lv: registerCapturedAsset(
					lv,
					frameAssetFilename(name, layer, frame, 'lv')
				),
				jpg: registerCapturedAsset(
					jpg,
					frameAssetFilename(name, layer, frame, 'jpg')
				),
				raw: raw
					? registerCapturedAsset(
							raw,
							frameAssetFilename(name, layer, frame, 'raw')
						)
					: undefined,
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

// Place a freshly shot frame at the capture slot, then move the capture cursor
// to the next empty frame. When the final frame of the duration was just filled,
// grow the timeline by one so the cursor lands on a real (visible) empty frame
// instead of hanging one past the end.
function placeShotAndAdvance(newShot: Shot) {
	project.$patch(state => {
		const {frame, layer} = state.captureShot
		project.setShot(frame, layer, newShot)

		// Next frame without a base-layer shot.
		let next = frame + 1
		while (next < state.komas.length && state.komas[next]?.shots[0]) {
			next++
		}
		// We filled the last frame — extend the duration by one.
		if (next >= state.komas.length) {
			state.komas.push({shots: []})
		}

		state.captureShot = {frame: next, layer: 0}
		state.previewRange[1] = state.captureShot.frame
	})

	viewport.setCurrentFrame(project.captureShot.frame)
	viewport.setCurrentLayer(project.captureShot.layer)
}

const oscIn = osc.receivers({
	shoot: {address: '/shoot', type: 'b', default: 0},
})

whenever(oscIn.shoot, () => Tq.actions.perform('shoot'))

//------------------------------------------------------------------------------

// A single Joy-Con (R) paired on its own is held rotated 90° CW, and its raw
// stick axes come in turned a quarter-turn from how the operator perceives
// them. Rotate the raw direction a quarter-turn so the arrow-key-aligned
// bindings below land on the operator's directions:
//   physical up → next frame, right → next layer, down → prev frame,
//   left → prev layer.
const gamepadAxis = gamepad
	.axisDirection()
	.map((v): vec2 | null => (v ? [-v[1], v[0]] : null))

const gamepadAxisNeutral = gamepadAxis.filter(v => v === null)
const gamepadAxisLeft = gamepadAxis.map(v => v && v[0] === -1)
const gamepadAxisRight = gamepadAxis.map(v => v && v[0] === 1)
const gamepadAxisUp = gamepadAxis.map(v => v && v[1] === -1)
const gamepadAxisDown = gamepadAxis.map(v => v && v[1] === 1)

// Hold the advance direction (next frame, physical up) to play forward.
gamepadAxisRight.longPress(500).pressed.on(() => {
	viewport.isPlaying = true
})

gamepadAxisNeutral.on(() => {
	viewport.isPlaying = false
})

//------------------------------------------------------------------------------
// Peek the previous koma while held: temporarily force onionskin off and display
// the frame one before the current one, without moving currentFrame. Releasing
// restores both. Bound to the '0' key and the gamepad B button.

const keyboard = Bndr.keyboard()
let peeking = false
let peekRestoreOnionskin = true

function setPeek(active: boolean) {
	if (active === peeking) return
	peeking = active
	if (active) {
		peekRestoreOnionskin = viewport.enableOnionskin
		viewport.enableOnionskin = false
		viewport.temporalFrame = Math.max(0, viewport.currentFrame - 1)
	} else {
		viewport.enableOnionskin = peekRestoreOnionskin
		viewport.temporalFrame = null
	}
}

keyboard.pressed('0', {capture: true, preventDefault: true}).on(setPeek)
gamepad.button('b').on(setPeek)

// Apply only the exposure-related configs of a shot to the connected camera —
// not model / imageQuality / focus etc. importConfigs applies them in
// dependency order (exposureMode before aperture/iso/shutterSpeed, whiteBalance
// before colorTemperature), so passing a plain subset is safe.
const exposureConfigNames = [
	'exposureMode',
	'aperture',
	'shutterSpeed',
	'iso',
	'exposureComp',
	'whiteBalance',
	'colorTemperature',
] as const

async function applyExposureFromShot(shot: Shot | null) {
	const {tethr} = camera
	if (!tethr) {
		alert('No camera is connected.')
		return
	}

	const configs = shot?.cameraConfigs
	if (!configs) {
		alert('No exposure settings to copy.')
		return
	}

	const exposureConfigs = Object.fromEntries(
		exposureConfigNames
			.filter(name => configs[name] !== undefined)
			.map(name => [name, configs[name]])
	)

	await tethr.importConfigs(exposureConfigs)
}

Tq.actions.register([
	{
		id: 'file',
		order: 10,
		icon: 'mdi:folder',
		children: [
			{
				id: 'create_new',
				label: 'Create New Project',
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
					await Tq.modal.promptTabs(
						[
							{
								id: 'general',
								title: 'General',
								scheme: {
									name: {type: 'string'},
									fps: {type: 'number', min: 1, max: 60, step: 1},
									duration: {type: 'number', min: 0, step: 1},
								},
								value: {
									name: project.name,
									fps: project.fps,
									duration: project.duration,
								},
								onInput(v) {
									project.setDuration(v.duration)
									project.$patch({name: v.name, fps: v.fps})
								},
							},
							{
								id: 'shootCondition',
								title: 'Shoot Condition',
								scheme: {
									shootCondition: {
										type: 'string',
										ui: 'code',
										lang: 'javascript',
									},
								},
								value: {shootCondition: project.shootCondition},
								onInput(v) {
									project.$patch({shootCondition: v.shootCondition})
								},
							},
							{
								id: 'scripts',
								title: 'Scripts',
								scheme: {
									preShootScript: {
										type: 'string',
										ui: 'code',
										lang: 'javascript',
									},
									customScript: {
										type: 'string',
										ui: 'code',
										lang: 'javascript',
									},
								},
								value: {
									preShootScript: project.preShootScript ?? '',
									customScript: project.customScript ?? '',
								},
								onInput(v) {
									project.$patch(v)
								},
							},
						],
						{title: 'Project Settings'}
					)
				},
			},
		],
	},
	{
		id: 'preferences',
		order: 1000,
		icon: 'mdi:settings',
		bind: 'command+,',
		async perform() {
			// Track the appearance so a light/dark toggle can snap the
			// background to that mode's default (the user can then tweak it).
			let prevDark = Tq.theme.colorMode === 'dark'

			await Tq.modal.promptTabs(
				[
					{
						id: 'appearances',
						title: 'Appearances',
						scheme: {
							accentColor: {type: 'string', ui: 'color'},
							grayColor: {type: 'string', ui: 'color'},
							backgroundColor: {type: 'string', ui: 'color'},
							darkMode: {type: 'boolean'},
						},
						value: {
							accentColor: Tq.theme.accentColor,
							grayColor: Tq.theme.grayColor,
							backgroundColor: Tq.theme.backgroundColor,
							darkMode: prevDark,
						},
						onInput(value) {
							// On a light/dark toggle, reset the background to the mode
							// default and keep the form's copy in sync so a later edit
							// doesn't push the stale value back.
							if (value.darkMode !== prevDark) {
								value.backgroundColor = value.darkMode
									? '#111111'
									: '#ffffff'
								prevDark = value.darkMode
							}
							Tq.theme.accentColor = value.accentColor
							Tq.theme.grayColor = value.grayColor
							Tq.theme.backgroundColor = value.backgroundColor
							Tq.theme.colorMode = value.darkMode ? 'dark' : 'light'
						},
					},
					{
						id: 'projects',
						title: 'In-App Projects',
						component: markRaw(InAppProjectsPanel),
					},
				],
				{title: 'Preferences'}
			)
		},
	},
	{
		id: 'camera',
		order: 60,
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
			{
				id: 'apply_exposure_from_koma',
				label: 'Apply Exposure from Selected Koma',
				icon: 'mdi:exposure',
				perform() {
					return applyExposureFromShot(
						project.shot(viewport.currentFrame, viewport.currentLayer)
					)
				},
			},
			{
				id: 'apply_exposure_from_prev_frame',
				label: 'Apply Exposure from Previous Frame',
				icon: 'mdi:content-copy',
				bind: 'p',
				perform() {
					// Same layer as the capture frame, one frame to the left.
					return applyExposureFromShot(
						project.shot(
							project.captureShot.frame - 1,
							project.captureShot.layer
						)
					)
				},
			},
		],
	},
	{
		id: 'capture',
		order: 70,
		icon: 'tabler:capture-filled',
		children: [
			{
				id: 'shoot',
				icon: 'mdi:circle',
				bind: ['enter', 'gamepad:a'],
				async perform() {
					const newShot = await shoot()
					placeShotAndAdvance(newShot)
				},
			},
			{
				id: 'force-shoot',
				icon: 'mdi:circle',
				bind: ['command+enter'],
				async perform() {
					const newShot = await shoot(true)
					placeShotAndAdvance(newShot)
				},
			},
			{
				id: 'auto_focus',
				icon: 'mdi:camera-iris',
				bind: '1',
				perform() {
					camera.tethr?.runAutoFocus()
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
		id: 'script',
		order: 80,
		icon: 'mdi:script-text-play',
		children: [
			{
				id: 'run_custom_script',
				label: 'Run Custom Script',
				icon: 'mdi:script-text-play',
				async perform() {
					await runCustomScript()
				},
			},
		],
	},
	{
		id: 'edit',
		order: 20,
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
		order: 30,
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
				bind: ['down', gamepadAxisDown.down()],
				perform() {
					viewport.setCurrentLayer(viewport.currentLayer + 1)
					viewport.selectShot()
				},
			},
			{
				id: 'decrement_current_layer',
				icon: 'mdi:arrow-up',
				bind: ['up', gamepadAxisUp.down()],
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
		order: 40,
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
				bind: ['gamepad:r', 'o'],
				perform() {
					viewport.enableOnionskin = !viewport.enableOnionskin
				},
			},
			{
				id: 'toggle_colored_onionskin',
				icon: 'fluent-emoji-high-contrast:onion',
				bind: ['c'],
				perform: () => {
					viewport.coloredOnionskin = !viewport.coloredOnionskin
				},
			},
		],
	},
	{
		id: 'playback',
		order: 50,
		icon: 'mdi:animation-play',
		children: [
			{
				id: 'toggle_play',
				icon: 'mdi:play',
				bind: ['space', 'gamepad:home'],
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

// Recent Projects: appended (below a splitter) to the File menu group, and kept
// in sync with the persisted list. 💾 = in-app, 📁 = filesystem folder.
watchEffect(() => {
	Tq.actions.setMenuExtras(
		'file',
		project.recentProjects.map(p => ({
			label: p.name,
			icon: p.type === 'opfs' ? 'octicon:cache-16' : 'mdi:folder',
			perform: () => project.openRecent(p),
		}))
	)
})
</script>

<template>
	<Tq.App>
		<template #title>
			<TitleBar />
		</template>
		<template #default>
			<Tq.PaneSplit
				name="vertical"
				direction="vertical"
				fixed="second"
				:size="300"
			>
				<template #first>
					<Tq.PaneSplit
						name="preview"
						direction="horizontal"
						fixed="second"
						:size="300"
						:scroll="[false, false]"
					>
						<template #first>
							<Preview class="preview" />
						</template>
						<template #second>
							<CameraTrajectoryVisualizer />
						</template>
					</Tq.PaneSplit>
				</template>
				<template #second>
					<Tq.PaneSplit
						name="bottom"
						direction="horizontal"
						fixed="first"
						:size="280"
					>
						<template #first>
							<div class="control">
								<Tq.ParameterGrid>
									<Tq.Parameter label="Tool">
										<Tq.InputRadio
											v-model="timeline.currentTool"
											:options="['select', 'marker', 'pencil', 'eraser']"
											:icons="[
												'ph:cursor-fill',
												'subway:mark',
												'mdi:pencil',
												'mdi:eraser',
											]"
											:tooltips="[
												'Select (V)',
												'Marker (M)',
												'Pencil (G)',
												'Eraser (E)',
											]"
										/>
									</Tq.Parameter>
									<CameraControl />
									<DmxControl />
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
		</template>
	</Tq.App>
</template>

<style lang="stylus" scoped>
.preview
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
