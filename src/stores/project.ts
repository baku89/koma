import {asyncComputed, pausableWatch, useRefHistory} from '@vueuse/core'
import {mat2d, quat, vec2, vec3} from 'linearly'
import {clamp, cloneDeep} from 'lodash'
import {defineStore} from 'pinia'
import {ConfigType} from 'tethr'
import {computed, nextTick, reactive, shallowRef, toRaw, toRefs} from 'vue'

import {
	assignReactive,
	debounceAsync,
	deepMergeExceptArray,
	openBlobJson,
	preventConcurrentExecution,
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
		liveviewTransform: mat2d
		shotTransform: mat2d
		overlay: SVGString
		overlayMaskOpacity: number
		overlayLineOpacity: number
		onionskinBlend: MixBlendMode
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
		focalLength: 50,
		focusDistance: 24,
		aperture: 5.6,
		shutterSpeed: '1/100',
		iso: 100,
		colorTemperature: 5500,
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
		liveviewTransform: mat2d.identity,
		shotTransform: mat2d.identity,
		overlay: `
			<!--<path class="letterbox" d="m0,0v1h1V0H0Zm.9.9H.1V.1h.8v.8Z"/>-->
			<line class="line" x1="0" y1=".5" x2="1" y2=".5" />
			<line class="line" x1=".5" y1="0" x2=".5" y2="1" />
		`,
		overlayMaskOpacity: 0.5,
		overlayLineOpacity: 1,
		onionskinBlend: 'normal',
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

	const directoryHandle = shallowRef<FileSystemDirectoryHandle | null>(null)

	const isSavedToDisk = asyncComputed(
		async () => directoryHandle.value !== (await opfs.localDirectoryHandle)
	)

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
			directoryHandle.value = handler ?? (await showReadwriteDirectoryPicker())

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
		const handle = await showReadwriteDirectoryPicker()

		if (project.name === emptyProject.name && handle.name !== '') {
			project.name = handle.name
		}

		await save(handle)
	}

	async function saveInOpfs() {
		await save(await opfs.localDirectoryHandle)
	}

	const {fn: save, isExecuting: isSaving} = debounceAsync(
		async (handle: FileSystemDirectoryHandle) => {
			if (isOpeningAutoSavedProject) return

			directoryHandle.value = handle

			await saveBlobJson(handle, toRaw(project), {
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
		}
	)

	// Enable autosave
	const autoSave = pausableWatch(project, save, {deep: true})

	// Open the auto-saved project in OPFS
	let isOpeningAutoSavedProject = true
	opfs.localDirectoryHandle.then(async handler => {
		try {
			await open(handler)
		} finally {
			isOpeningAutoSavedProject = false
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
		saveAs,
		saveInOpfs,
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
