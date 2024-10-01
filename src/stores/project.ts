import {
	asyncComputed,
	pausableWatch,
	useRefHistory,
	whenever,
} from '@vueuse/core'
import {useIDBKeyval} from '@vueuse/integrations/useIDBKeyval'
import {mat2d, quat, vec2, vec3} from 'linearly'
import {clamp, cloneDeep, debounce, isEqual} from 'lodash-es'
import sleep from 'p-sleep'
import {defineStore} from 'pinia'
import {ConfigType} from 'tethr'
import {computed, nextTick, reactive, toRaw, toRefs} from 'vue'

import {
	assignReactive,
	debounceAsync,
	deepMergeExceptArray,
	openBlobJson,
	preventConcurrentExecution,
	queryPermission,
	saveBlobJson,
	showReadwriteDirectoryPicker,
} from '@/utils'

import defaultShootCondition from './defaultShootCondition.js?raw'
import {useOpfsStore} from './opfs'

export const MixBlendModeValues: MixBlendMode[] = [
	'normal',
	'lighten',
	'darken',
	'difference',
]

type MixBlendMode = 'normal' | 'lighten' | 'darken' | 'difference'

interface Project<T = Blob> {
	name: string
	fps: number
	captureShot: {frame: number; layer: number}
	previewRange: [number, number]
	onionskin: number
	komas: Koma<T>[]
	resolution: vec2
	timeline: {
		zoomFactor: number
		drawing?: PaperJSData
	}
	isLooping: boolean
	shootCondition: JSCode
	cameraConfigs: CameraConfigs
	visibleProperties: Record<string, {visible: boolean; color: string}>
	viewport: {
		transform: mat2d | 'fit'
		overlay: SVGString
		zoom: number
	}
	layers: {
		opacity: number
		mixBlendMode: MixBlendMode
	}[]
	audio: {
		src?: T
		startFrame: number
	}
	markers: Marker[]
}

type UndoableData = Pick<Project, 'komas' | 'captureShot' | 'markers'> & {
	drawing?: PaperJSData
}

type SVGString = string
type PaperJSData = ReturnType<typeof JSON.parse>
type JSCode = string

type CameraConfigs = Partial<ConfigType>

interface Koma<T = Blob> {
	shots: (Shot<T> | null)[]
	backupShots?: Shot<T>[]
	target?: {
		cameraConfigs?: CameraConfigs
		tracker?: {
			position: vec3
			rotation: quat
		}
		dmx?: number[]
	}
}

export interface Marker {
	label: string
	frame: number
	verticalPosition: number
	duration: number
	color: string
}

export interface Shot<T = Blob> {
	lv: T
	jpg: T
	raw?: T
	jpgFilename?: string
	rawFilename?: string
	cameraConfigs?: CameraConfigs
	tracker?: {
		position: vec3
		rotation: quat
	}
	dmx?: number[]
	shootTime?: number
	captureDate?: number
}

const emptyProject: Project = {
	name: 'Untitled',
	fps: 15,
	previewRange: [0, 0],
	onionskin: 0,
	timeline: {
		zoomFactor: 1,
	},
	isLooping: false,
	// Drops the ';' at the beginning inserted by Eslint
	shootCondition: defaultShootCondition.slice(1),
	cameraConfigs: {
		exposureMode: 'M',
		aperture: 4,
		shutterSpeed: '1/30',
		iso: 100,
		whiteBalance: 'fluorescent',
		colorTemperature: 5500,
		imageQuality: 'raw 14bit,fine',
	},
	visibleProperties: {
		shootTime: {visible: true, color: '#ffffff'},
		focalLength: {visible: true, color: '#ff0000'},
		focusDistance: {visible: true, color: '#00ff00'},
		aperture: {visible: true, color: '#0000ff'},
		shutterSpeed: {visible: true, color: '#ffff00'},
		iso: {visible: true, color: '#00ffff'},
		colorTemperature: {visible: true, color: '#ff00ff'},
	},
	captureShot: {frame: 0, layer: 0},
	komas: Array(15)
		.fill(null)
		.map(() => ({shots: []})),
	resolution: [1920, 1280],
	viewport: {
		transform: 'fit',
		overlay: `
			<!--<path class="letterbox" d="m0,0v1h1V0H0Zm.9.9H.1V.1h.8v.8Z"/>-->
			<line class="line" x1="0" y1=".5" x2="1" y2=".5" />
			<line class="line" x1=".5" y1="0" x2=".5" y2="1" />
		`,
		zoom: 1.3,
	},
	layers: [
		{opacity: 1, mixBlendMode: 'normal'},
		{opacity: 1, mixBlendMode: 'difference'},
	],
	audio: {
		startFrame: 0,
	},
	markers: [],
}

export const useProjectStore = defineStore('project', () => {
	const opfs = useOpfsStore()

	// Open the auto-saved project on startup
	const {data: directoryHandle, isFinished: isDirectoryHandlePersisted} =
		useIDBKeyval(
			'com.baku89.koma.project.directoryHandle',
			null as FileSystemDirectoryHandle | null,
			{shallow: true}
		)

	const isSavedToDisk = asyncComputed(async () => {
		if (!directoryHandle.value) return false

		const isSavedToOPFS = await directoryHandle.value.isSameEntry(
			await opfs.localDirectoryHandle
		)

		return !isSavedToOPFS
	})

	const project = reactive<Project>(cloneDeep(emptyProject))

	const undoableData = computed<UndoableData>({
		get() {
			return {
				captureShot: project.captureShot,
				komas: project.komas,
				markers: project.markers,
				drawing: project.timeline.drawing,
			}
		},
		set(data) {
			project.captureShot = data.captureShot
			project.komas = data.komas
			project.markers = data.markers
			project.timeline.drawing = data.drawing
		},
	})

	const history = useRefHistory(undoableData, {
		deep: true,
		capacity: 400,
		clone: cloneDeep,
	})

	const allKomas = computed<Koma[]>(() => {
		const komaNumberToFill =
			Math.max(project.captureShot.frame - project.komas.length + 1, 0) + 1

		return [
			...project.komas,
			...Array(komaNumberToFill)
				.fill(null)
				.map(() => ({shots: []})),
		]
	})

	const previewKomas = computed<Koma[]>(() => {
		const [inPoint, outPoint] = project.previewRange
		return allKomas.value.slice(inPoint, outPoint + 1)
	})

	// Open and Save Projects
	async function createNew() {
		await save()

		if (!isSavedToDisk.value && !isEqual(toRaw(project), emptyProject)) {
			if (
				!confirm(
					'Do you want to create a new project? Your unsaved changes will be lost.'
				)
			) {
				return
			}
		}

		directoryHandle.value = await opfs.localDirectoryHandle

		assignReactive(project, cloneDeep(emptyProject))

		nextTick(() => history.clear())

		if (directoryHandle.value?.name === '') {
			for await (const key of directoryHandle.value.keys()) {
				directoryHandle.value.removeEntry(key)
			}
		}
	}

	const {fn: open, isExecuting: isOpening} = preventConcurrentExecution(
		async (handler?: FileSystemDirectoryHandle) => {
			await sleep(0) // Wait for the next tick to show the dialog

			directoryHandle.value = handler ?? (await showReadwriteDirectoryPicker())

			await queryPermission(directoryHandle.value)

			if (!directoryHandle.value) {
				throw new Error('No directory is selected')
			}

			const unflatProject = (await openBlobJson(directoryHandle.value, {
				openBlob: opfs.open,
			})) as unknown as Project

			// In case the latest project format has more properties than the saved one,
			// merge the saved state with the default state
			const mergedProject = deepMergeExceptArray(unflatProject, emptyProject)

			autoSave.pause()
			assignReactive(project, mergedProject)
			autoSave.resume()

			nextTick(() => history.clear())
		},
		() => undefined
	)

	async function saveAs() {
		await sleep(0) // Wait for the next tick to show the dialog

		const handle = await showReadwriteDirectoryPicker()

		if (project.name === emptyProject.name && handle.name !== '') {
			project.name = handle.name
		}

		directoryHandle.value = handle
		save()
	}

	const {fn: save, isExecuting: isSaving} = debounceAsync(async () => {
		if (isOpening.value) return

		if (!directoryHandle.value) {
			throw new Error('No directory is specified')
		}

		await saveBlobJson(directoryHandle.value, toRaw(project), {
			saveBlob: opfs.save,
			pathToFilename(path) {
				const [first, frame, , layer, type] = path

				if (first === 'komas' && typeof frame === 'number') {
					const lv = type === 'lv' ? '_lv' : ''
					const seq = frame.toString().padStart(4, '0')
					const ext = type === 'raw' ? 'dng' : 'jpg'

					return `${project.name}_layer=${layer}${lv}_${seq}.${ext}`
				}
			},
		})
	})

	// Enable autosave
	const autoSave = pausableWatch(project, debounce(save, 500), {deep: true})

	whenever(isDirectoryHandlePersisted, () => {
		if (directoryHandle.value) {
			open(directoryHandle.value)
		} else {
			opfs.localDirectoryHandle.then(open)
		}
	})

	//----------------------------------------------------------------------------
	// Mutations

	function setInPoint(value: number) {
		const inPoint = Math.min(value, project.previewRange[1])
		project.previewRange = [inPoint, project.previewRange[1]]
	}

	function setOutPoint(value: number) {
		const outPoint = clamp(
			value,
			project.previewRange[0],
			allKomas.value.length - 1
		)

		project.previewRange = [project.previewRange[0], outPoint]
	}

	function shot(frame: number, layer: number): Shot | null {
		return project.komas[frame]?.shots?.at(layer) ?? null
	}

	function setShot(frame: number, layer: number, shot: Shot) {
		while (frame >= project.komas.length) {
			project.komas.push({shots: []})
		}

		let koma = project.komas[frame] ?? {}

		if (!koma.shots) {
			// If there is no frame, create a new frame
			project.komas[frame] = koma = {...koma, shots: []}
		}

		while (layer >= koma.shots.length) {
			// If there is not enough layer, push layers
			koma.shots.push(null)
		}

		koma.shots[layer] = shot
	}

	function layer(layer: number) {
		while (layer >= project.layers.length) {
			project.layers.push({opacity: 1, mixBlendMode: 'normal'})
		}

		return project.layers[layer]
	}

	function layerCount(frame: number) {
		return allKomas.value[frame]?.shots?.length ?? 0
	}

	const duration = computed({
		get() {
			return project.komas.length
		},
		set(value) {
			while (value >= project.komas.length) {
				project.komas.push({shots: []})
			}
		},
	})

	return {
		...toRefs(project),
		history,
		undo: history.undo,
		redo: history.redo,
		createNew,
		open,
		save,
		saveAs,
		allKomas,
		previewKomas,
		setInPoint,
		setOutPoint,
		isOpening,
		isSaving,
		isSavedToDisk,
		shot,
		setShot,
		layer,
		layerCount,
		duration,
	}
})
