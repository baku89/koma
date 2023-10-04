import {useRefHistory} from '@vueuse/core'
import {merge} from 'lodash'
import {ConfigType} from 'tethr'
import {computed, reactive, shallowRef} from 'vue'

import {mapToPromises, queryString} from './util'

/**
 * Termiology
 * - Frame: An integer that represents a frame number (starts from 0)
 * - Koma: A frame data that contains multiple Shots
 * - Shot: A single image data that contains images and metadata
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

export function useProject() {
	const directoryHandler = shallowRef<FileSystemDirectoryHandle | null>(null)

	const state = reactive<ProjectState>(emptyProject.state)
	const data = shallowRef<ProjectData>(emptyProject.data)
	const lastSaved = shallowRef<ProjectData>(emptyProject.data)

	const hasModified = computed(() => data.value !== lastSaved.value)

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
	async function getDirectoryHandler() {
		const handler = await window.showDirectoryPicker({id: 'saveFile'})

		const option: FileSystemHandlePermissionDescriptor = {
			mode: 'readwrite',
		}

		const permission = await handler.queryPermission(option)

		if (permission !== 'granted') {
			const permission = await handler.requestPermission(option)
			if (permission === 'denied') throw new Error('Permission denied')
		}

		return handler
	}

	async function open() {
		directoryHandler.value = await getDirectoryHandler()
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
		const mergedData = {...emptyProject.data, ...unflatData, frames}

		for (const key of Object.keys(emptyProject.data)) {
			;(state as any)[key] = (mergedState as any)[key]
		}

		data.value = mergedData
		lastSaved.value = data.value
	}

	async function save() {
		if (directoryHandler.value === null) {
			directoryHandler.value = await getDirectoryHandler()
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
		saveText(json, 'project.json')

		lastSaved.value = data.value
	}

	async function openShot(shot: Shot<string>): Promise<Shot> {
		const lv = await openBlob(shot.lv)
		const jpg = await openBlob(shot.jpg)
		const raw = shot.raw ? await openBlob(shot.raw) : undefined

		return {...shot, lv, jpg, raw}
	}

	// Saves a frame to the project directrory and replace all Blob entries with the name of the file
	async function saveShot(
		shot: Shot,
		frame: number,
		query: Record<string, string | number>
	): Promise<Shot<string>> {
		const basename = [data.value.name, queryString(query)].join('_')

		const lv = await saveSequenceImage(shot.lv, basename + '_lv', frame, 'jpg')
		const jpg = await saveSequenceImage(shot.jpg, basename, frame, 'jpg')
		const raw = shot.raw
			? await saveSequenceImage(shot.raw, basename, frame, 'dng')
			: undefined

		return {...shot, lv, jpg, raw}
	}

	// File System Access API utils
	async function loadText(filename: string): Promise<string> {
		if (!directoryHandler.value) throw new Error('No directory handler')

		const h = await directoryHandler.value.getFileHandle(filename)
		const f = await h.getFile()
		const text = await f.text()
		return text
	}

	async function saveText(text: string, fileName: string) {
		if (!directoryHandler.value) throw new Error('No directory handler')

		const h = await directoryHandler.value.getFileHandle(fileName, {
			create: true,
		})

		const w = await h.createWritable()
		await w.write(text)
		await w.close()
	}

	async function openBlob(filename: string): Promise<Blob> {
		if (!directoryHandler.value) throw new Error('No directory handler')

		try {
			const h = await directoryHandler.value.getFileHandle(filename)
			return await h.getFile()
		} catch (err) {
			return undefined as any // TODO: for DNG
		}
	}

	// Save the BLob image to the project directrory and returns the name of the file
	async function saveSequenceImage(
		blob: Blob,
		basename: string,
		frame: number,
		extension: string
	) {
		if (!directoryHandler.value) throw new Error('No directory handler')

		const suffix = frame.toString().padStart(4, '0')
		const fileName = `${basename}_${suffix}.${extension}`

		const h = await directoryHandler.value.getFileHandle(fileName, {
			create: true,
		})

		const w = await h.createWritable()
		await w.write(blob)
		await w.close()

		return fileName
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

	function setInPoint(value: number) {
		const inPoint = Math.min(value, state.previewRange[1])
		state.previewRange = [inPoint, state.previewRange[1]]
	}

	function setOutPoint(value: number) {
		const outPoint = Math.max(value, state.previewRange[0])
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
}
