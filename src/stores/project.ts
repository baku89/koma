import {useRefHistory, whenever} from '@vueuse/core'
import {produce} from 'immer'
import {clamp, merge} from 'lodash'
import {defineStore} from 'pinia'
import {ConfigType} from 'tethr'
import {computed, reactive, shallowRef} from 'vue'

import {
	getDirectoryHandle,
	mapToPromises,
	openBlob,
	queryString,
	saveBlob,
} from '@/util'

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
	state: ProjectState
	data: ProjectData<T>
}

interface CameraConfigs {
	focalLength?: ConfigType['focalLength']
	focusDistance?: ConfigType['focusDistance']
	aperture?: ConfigType['aperture']
	shutterSpeed?: ConfigType['shutterSpeed']
	iso?: ConfigType['iso']
	colorTemperature?: ConfigType['colorTemperature']
}

// A project-specific data that does not need to be history-tracked
interface ProjectState {
	previewRange: [number, number]
	onionskin: number
	timeline: {
		komaWidth: number
	}
	cameraConfigs: CameraConfigs
}

// A project-specific data that needs to be history-tracked
interface ProjectData<T = Blob> {
	name: string
	fps: number
	captureFrame: number
	komas: Koma<T>[]
}

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

const urlForBlob = new WeakMap<Blob, string>()

const emptyProject: Project = {
	state: {
		previewRange: [0, 9],
		onionskin: 0,
		timeline: {
			komaWidth: 1,
		},
		cameraConfigs: {
			focalLength: 50,
			focusDistance: 24,
			aperture: 5.6,
			shutterSpeed: '1/100',
			iso: 100,
			colorTemperature: 5500,
		},
	},
	data: {
		fps: 15,
		name: 'Untitled',
		captureFrame: 0,
		komas: Array(10).fill(null),
	},
}

export function getObjectURL(blob: Blob) {
	let url = urlForBlob.get(blob)
	if (!url) {
		url = URL.createObjectURL(blob)
		urlForBlob.set(blob, url)
	}
	return url
}

export const useProjectState = defineStore('project', () => {
	const directoryHandle = shallowRef<FileSystemDirectoryHandle | null>(null)

	const state = reactive<ProjectState>(emptyProject.state)
	const data = shallowRef<ProjectData>(emptyProject.data)

	const lastSavedData = shallowRef<ProjectData>(emptyProject.data)
	const hasModified = computed(() => data.value !== lastSavedData.value)

	const history = useRefHistory(data, {capacity: 400})

	const captureFrame = computed({
		get: () => data.value.captureFrame,
		set: value => ({...data.value, captureFrame: value}),
	})

	const allKomas = computed<Koma[]>(() => {
		const komaNumberToFill = Math.max(
			data.value.captureFrame - data.value.komas.length + 1,
			0
		)

		return [...data.value.komas, ...Array(komaNumberToFill).fill(null)]
	})

	// Open and Save Projects

	async function open() {
		directoryHandle.value = await getDirectoryHandle()
		history.clear()

		const {state: flatState, data: flatData} = JSON.parse(
			await loadText('project.json')
		) as Project<string>

		const unflatData: ProjectData<Blob> = {
			...flatData,
			komas: await mapToPromises(flatData.komas, async koma => {
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
		const mergedState = merge(flatState, emptyProject.state)

		// Don't need to deepmerge
		const mergedData = {...emptyProject.data, ...unflatData}

		for (const key of Object.keys(emptyProject.data)) {
			;(state as any)[key] = (mergedState as any)[key]
		}

		data.value = lastSavedData.value = mergedData
	}

	async function save() {
		if (!hasModified.value) return

		if (directoryHandle.value === null) {
			const handler = await getDirectoryHandle()
			directoryHandle.value = handler

			if (data.value.name === emptyProject.data.name) {
				data.value = produce(data.value, draft => {
					draft.name = handler.name
				})
			}
		}

		const flatData: ProjectData<string> = {
			...data.value,
			komas: await mapToPromises(data.value.komas, async (koma, frame) => {
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

		const json = JSON.stringify({state, data: flatData})
		await saveText(json, 'project.json')

		lastSavedData.value = data.value
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
		const basename = [data.value.name, queryString(query)].join('_')

		const lv = await saveImageSequence(shot.lv, basename + '_lv', frame, 'jpg')
		const jpg = await saveImageSequence(shot.jpg, basename, frame, 'jpg')
		const raw = shot.raw
			? await saveImageSequence(shot.raw, basename, frame, 'dng')
			: undefined

		return {...shot, lv, jpg, raw}
	}

	// File System Access API utils
	async function loadText(filename: string): Promise<string> {
		if (!directoryHandle.value) throw new Error('No directory handler')

		const h = await directoryHandle.value.getFileHandle(filename)
		const f = await h.getFile()
		const text = await f.text()
		return text
	}

	async function saveText(text: string, fileName: string) {
		if (!directoryHandle.value) throw new Error('No directory handler')

		const h = await directoryHandle.value.getFileHandle(fileName, {
			create: true,
		})

		const w = await h.createWritable()
		await w.write(text)
		await w.close()
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

		saveBlob(directoryHandle, filename, blob)

		return filename
	}

	function pauseHistory() {
		history.pause()
	}

	function pushHistory() {
		history.resume()
		if (data.value !== history.last.value.snapshot) {
			history.commit()
		}
	}

	// Enable autosave
	whenever(hasModified, save, {flush: 'post'})

	function setInPoint(value: number) {
		const inPoint = Math.min(value, state.previewRange[1])
		state.previewRange = [inPoint, state.previewRange[1]]
	}

	function setOutPoint(value: number) {
		const outPoint = clamp(
			value,
			state.previewRange[0],
			allKomas.value.length - 1
		)

		state.previewRange = [state.previewRange[0], outPoint]
	}

	return {
		state,
		data,
		history,
		pauseHistory,
		pushHistory,
		hasModified,
		open,
		save,
		captureFrame,
		allKomas: allKomas,
		setInPoint,
		setOutPoint,
	}
})
