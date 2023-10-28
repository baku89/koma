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
	loadJson,
	mapPromises,
	mapValuePromises,
	preventConcurrentExecution,
	queryString,
	saveJson,
	showReadwriteDirectoryPicker,
} from '@/util'

import {useBlobStore} from './blobCache'

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
		markerSounds: Record<string, T>
		drawing: PaperJSData
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

type UndoableData = Pick<Project, 'komas' | 'captureShot'>

type SVGString = string
type PaperJSData = any
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
	sound?: string
}

export interface Shot<T = Blob> {
	lv: T
	jpg: T
	raw?: T
	cameraConfigs: CameraConfigs
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
		markerSounds: {},
		drawing: null,
	},
	isLooping: false,
	shootCondition: `({camera, aux}) => {
	const alerts = []

	if (camera.tethr) {
		if (camera.exposureMode.value !== 'M') {
			alerts.push('Exposure mode must be set to M')
		}

		if (typeof camera.iso.value !== 'number') {
			alerts.push('ISO must be set to a number')
		}

		if (camera.whiteBalance.value !== 'manual') {
			alerts.push('White balance must be set to manual')
		}
	} else {
		alerts.push('Camera must be connected')
	}

	if (aux.tracker.enabled) {
		if (vec3.len(aux.tracker.velocity) >= 0.01) {
			alerts.push('Tracker must be stable')
		}
	} else {
		alerts.push('Tracker must be connected')
	}

	return alerts
}`,
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
	komas: [],
	resolution: [1920, 1280],
	viewport: {
		transform: 'fit',
		liveviewTransform: mat2d.identity,
		shotTransform: mat2d.identity,
		overlay: `
			<path class="letterbox" d="m0,0v1h1V0H0Zm.9.9H.1V.1h.8v.8Z"/>
			<line class="line" x1="0" y1=".5" x2="1" y2=".5" />
			<line class="line" x1=".5" y1="0" x2=".5" y2="1" />
		`,
		overlayMaskOpacity: 0.5,
		overlayLineOpacity: 1,
		onionskinBlend: 'normal',
	},
	layers: [],
	audio: {
		startFrame: 0,
	},
	markers: [],
}

export const useProjectStore = defineStore('project', () => {
	const blobCache = useBlobStore()

	const directoryHandle = shallowRef<FileSystemDirectoryHandle | null>(null)

	const isSavedToDisk = asyncComputed(
		async () =>
			directoryHandle.value &&
			directoryHandle.value !== (await blobCache.localDirectoryHandle)
	)

	const project = reactive<Project>(cloneDeep(emptyProject))

	const undoableData = computed<UndoableData>({
		get() {
			return {
				captureShot: project.captureShot,
				komas: project.komas,
			}
		},
		set(data) {
			project.captureShot = data.captureShot
			project.komas = data.komas
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

			const flatProject = await loadJson<Project<string>>(
				directoryHandle,
				'project.json'
			)

			const unflatProject: Project<Blob> = {
				...flatProject,
				timeline: {
					...flatProject.timeline,
					markerSounds: await mapValuePromises(
						flatProject.timeline.markerSounds,
						src => blobCache.open(directoryHandle, src)
					),
				},
				komas: await mapPromises(flatProject.komas, async koma => {
					const shots = await mapPromises(koma.shots, shot => {
						if (shot === null) return null
						return openShot(shot)
					})

					const backupShots = koma.backupShots
						? await mapPromises(koma.backupShots, openShot)
						: undefined

					return {...koma, shots, backupShots}
				}),
				audio: {
					...flatProject.audio,
					src: flatProject.audio.src
						? await blobCache.open(directoryHandle, flatProject.audio.src)
						: undefined,
				},
			}

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
		const handler = await showReadwriteDirectoryPicker()

		directoryHandle.value = handler

		if (project.name === emptyProject.name && handler.name !== '') {
			project.name = handler.name
		}

		await save()
	}

	async function saveInOpfs() {
		directoryHandle.value = await blobCache.localDirectoryHandle
		await save()
	}

	const {fn: save, isExecuting: isSaving} = debounceAsync(async () => {
		if (isOpeningAutoSavedProject) return

		// console.time('save')

		try {
			if (directoryHandle.value === null) {
				directoryHandle.value = await blobCache.localDirectoryHandle
			}

			const flatProject: Project<string> = {
				...toRaw(project),
				timeline: {
					...project.timeline,
					markerSounds: await mapValuePromises(
						project.timeline.markerSounds,
						(src, name) =>
							blobCache.save(directoryHandle, `marker_${name}.wav`, src)
					),
				},
				komas: await mapPromises(project.komas, async (koma, frame) => {
					const shots = await mapPromises(koma.shots, (shot, layer) => {
						if (shot === null) return null
						return saveShot(shot, frame, {layer})
					})

					const backupShots = koma.backupShots
						? await mapPromises(koma.backupShots, (shot, index) =>
								saveShot(shot, frame, {backup: index})
						  )
						: undefined

					return {...koma, shots, backupShots}
				}),
				audio: {
					...project.audio,
					src: project.audio.src
						? await blobCache.save(
								directoryHandle,
								'audio.wav',
								project.audio.src
						  )
						: undefined,
				},
			}

			await saveJson(directoryHandle, flatProject, 'project.json')
		} finally {
			// console.timeEnd('save')
		}
	})

	async function openShot(shot: Shot<string>): Promise<Shot> {
		const lv = await blobCache.open(directoryHandle, shot.lv)
		const jpg = await blobCache.open(directoryHandle, shot.jpg)
		const raw = shot.raw
			? await blobCache.open(directoryHandle, shot.raw)
			: undefined

		return {...shot, lv, jpg, raw}
	}

	// Saves a frame to the project directrory and replace all Blob entries with the name of the file
	async function saveShot(
		shot: Shot,
		frame: number,
		query: Record<string, string | number>
	): Promise<Shot<string>> {
		const basename = [project.name, queryString(query)].join('_')

		const lv = await saveImageSequence(shot.lv, basename + '_lv', frame, 'jpg')
		const jpg = await saveImageSequence(shot.jpg, basename, frame, 'jpg')
		const raw = shot.raw
			? await saveImageSequence(shot.raw, basename, frame, 'dng')
			: undefined

		return {...shot, lv, jpg, raw}
	}

	// Save the blob image to the project directrory and returns the name of the file
	async function saveImageSequence(
		blob: Blob,
		basename: string,
		frame: number,
		extension: string
	) {
		const suffix = frame.toString().padStart(4, '0')
		const filename = `${basename}_${suffix}.${extension}`

		return blobCache.save(directoryHandle, filename, blob)
	}

	// Enable autosave
	const autoSave = pausableWatch(project, save, {deep: true, flush: 'sync'})

	// Open the auto-saved project in OPFS
	let isOpeningAutoSavedProject = true
	blobCache.localDirectoryHandle.then(async handler => {
		await open(handler)
		isOpeningAutoSavedProject = false
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
