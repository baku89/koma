import {useRefHistory} from '@vueuse/core'
import {mat2d} from 'linearly'
import {clamp, cloneDeep, merge} from 'lodash'
import {defineStore} from 'pinia'
import {ConfigType} from 'tethr'
import {computed, reactive, ref, shallowRef, toRaw, toRefs, watch} from 'vue'

import {
	getDirectoryHandle,
	loadJson,
	mapToPromises,
	openBlob,
	queryString,
	saveBlob,
	saveJson,
} from '@/util'

import {Mat2d} from '../../dev_modules/linearly/src/mat2d'
import {Vec2} from '../../dev_modules/linearly/src/vec2'

/**
 * Termiology
 * - Frame: An integer that represents a frame number (starts from 0)
 * - Koma: A frame data that contains multiple Shots
 * - Shot: A single image data that contains images and metadata
 *
 * - flatten data: A data represented as plain JS object and can be JSON-stringified
 * - unflatten data: A data that contains Blob objects
 **/

interface Project<T = Blob> {
	previewRange: [number, number]
	onionskin: number
	timeline: {
		zoomFactor: number
	}
	isLooping: boolean
	cameraConfigs: CameraConfigs
	name: string
	fps: number
	captureFrame: number
	komas: Koma<T>[]
	resolution: Vec2
	viewport: {
		transform: Mat2d | 'fit'
		liveviewTransform: Mat2d
		shotTransform: Mat2d
		overlay: SVGString
		onionskinBlend: 'normal' | 'lighten' | 'darken' | 'difference'
	}
}

type UndoableData = Pick<Project, 'komas' | 'captureFrame'>

type SVGString = string

type CameraConfigs = Partial<ConfigType>

type Koma<T = Blob> = EmptyKoma | CapturedKoma<T>

type EmptyKoma = null

interface CapturedKoma<T = Blob> {
	shots: (Shot<T> | null)[]
	backupShots: Shot<T>[]
}

export interface Shot<T = Blob> {
	lv: T
	jpg: T
	raw?: T
	cameraConfigs: CameraConfigs
}

const emptyProject: Project = {
	previewRange: [0, 9],
	onionskin: 0,
	timeline: {
		zoomFactor: 1,
	},
	isLooping: false,
	cameraConfigs: {
		focalLength: 50,
		focusDistance: 24,
		aperture: 5.6,
		shutterSpeed: '1/100',
		iso: 100,
		colorTemperature: 5500,
	},
	fps: 15,
	name: 'Untitled',
	captureFrame: 0,
	komas: Array(10).fill(null),
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
		onionskinBlend: 'normal',
	},
}

export const useProjectStore = defineStore('project', () => {
	const directoryHandle = shallowRef<FileSystemDirectoryHandle | null>(null)

	const project = reactive<Project>(cloneDeep(emptyProject))
	const hasModified = ref(false)

	const undoableData = computed<UndoableData>({
		get() {
			return {
				captureFrame: project.captureFrame,
				komas: project.komas,
			}
		},
		set(data) {
			project.captureFrame = data.captureFrame
			project.komas = data.komas
		},
	})

	const history = useRefHistory(undoableData, {capacity: 400})

	const allKomas = computed<Koma[]>(() => {
		const komaNumberToFill = Math.max(
			project.captureFrame - project.komas.length + 1,
			0
		)

		return [...project.komas, ...Array(komaNumberToFill).fill(null)]
	})

	// Open and Save Projects

	async function open() {
		directoryHandle.value = await getDirectoryHandle()
		history.clear()

		const flatProject = await loadJson<Project<string>>(
			directoryHandle,
			'project.json'
		)

		const unflatProject: Project<Blob> = {
			...flatProject,
			komas: await mapToPromises(flatProject.komas, async koma => {
				if (koma === null) return null

				const shots = await mapToPromises(koma.shots, shot => {
					if (shot === null) return null
					return openShot(shot)
				})

				const backupShots = await mapToPromises(koma.backupShots, openShot)

				return {...koma, shots, backupShots}
			}),
		}

		// In case the latest project format has more properties than the saved one,
		// merge the saved state with the default state
		const mergedState = merge(unflatProject, emptyProject)

		for (const key of Object.keys(emptyProject)) {
			;(project as any)[key] = (mergedState as any)[key]
		}
	}

	async function save() {
		if (directoryHandle.value === null) {
			const handler = await getDirectoryHandle()
			directoryHandle.value = handler

			if (project.name === emptyProject.name) {
				project.name = handler.name
			}
		}

		const flatProject: Project<string> = {
			...toRaw(project),
			komas: await mapToPromises(project.komas, async (koma, frame) => {
				if (koma === null) return null

				const shots = await mapToPromises(koma.shots, (shot, layer) => {
					if (shot === null) return null
					return saveShot(shot, frame, {layer})
				})

				const backupShots = await mapToPromises(
					koma.backupShots,
					(shot, index) => saveShot(shot, frame, {backup: index})
				)

				return {...koma, shots, backupShots}
			}),
		}

		await saveJson(directoryHandle, flatProject, 'project.json')
	}

	async function openShot(shot: Shot<string>): Promise<Shot> {
		const lv = await openBlob(directoryHandle, shot.lv)
		const jpg = await openBlob(directoryHandle, shot.jpg)
		const raw = shot.raw ? await openBlob(directoryHandle, shot.raw) : undefined

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

		return saveBlob(directoryHandle, filename, blob)
	}

	// Enable autosave
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

	watch(project, save, {deep: true})

	return {
		...toRefs(project),
		undo: history.undo,
		redo: history.redo,
		hasModified,
		open,
		save,
		allKomas,
		setInPoint,
		setOutPoint,
	}
})
