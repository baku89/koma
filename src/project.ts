import {useRefHistory} from '@vueuse/core'
import {computed, shallowRef} from 'vue'

interface ProjectData {
	name: string
	captureFrame: number
	frames: Frame[]
}

type Frame = EmptyFrame | CapturedFrame

type EmptyFrame = null

interface CapturedFrame {
	lv: Blob
	jpg: Blob
}

const urlForBlob = new WeakMap<Blob, string>()

const emptyProject: ProjectData = {
	name: 'Untitled',
	captureFrame: 0,
	frames: Array(10).fill(null),
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

	const data = shallowRef<ProjectData>(emptyProject)
	const lastSaved = shallowRef<ProjectData>(emptyProject)

	const hasModified = computed(() => data.value !== lastSaved.value)

	const history = useRefHistory(data, {capacity: 400})

	const captureFrame = computed({
		get: () => data.value.captureFrame,
		set: value => ({...data.value, captureFrame: value}),
	})

	const allFrames = computed<Frame[]>(() => {
		const framesToAdd = Math.max(
			data.value.captureFrame - data.value.frames.length + 1,
			0
		)

		return [...data.value.frames, ...Array(framesToAdd).fill(null)]
	})

	// Open and Save Projects

	async function open() {
		const handler = await window.showDirectoryPicker({id: 'saveFile'})

		const option: FileSystemHandlePermissionDescriptor = {
			mode: 'readwrite',
		}

		const permission = await handler.queryPermission(option)

		if (permission !== 'granted') {
			const permission = await handler.requestPermission(option)
			if (permission === 'denied') return
		}

		directoryHandler.value = handler
		history.clear()

		const flatten = JSON.parse(await loadText('project.json'))
		const frames: Frame[] = await Promise.all(
			flatten.frames.map(async (f: boolean, i: number) => {
				if (!f) return null

				return {
					lv: await openSequenceImage(flatten.name + '_lv', i, 'jpg'),
					jpg: await openSequenceImage(flatten.name, i, 'jpg'),
				}
			})
		)

		data.value = {...flatten, frames}
		lastSaved.value = data.value
	}

	async function save() {
		if (directoryHandler.value === null) {
			await open()
		}

		if (directoryHandler.value === null) return

		// Save Project File at first
		const flattened = {...data.value, frames: data.value.frames.map(f => !!f)}
		const json = JSON.stringify(flattened)
		saveText(json, 'project.json')

		// Save all frames
		const frames = data.value.frames

		for (const [i, frame] of frames.entries()) {
			if (frame === null) continue

			saveSequenceImage(frame.lv, data.value.name + '_lv', i, 'jpg')
			saveSequenceImage(frame.jpg, data.value.name, i, 'jpg')
		}

		lastSaved.value = data.value
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

	async function openSequenceImage(
		basename: string,
		frame: number,
		extension: string
	): Promise<Blob> {
		if (!directoryHandler.value) throw new Error('No directory handler')

		const suffix = frame.toString().padStart(4, '0')
		const fileName = `${basename}_${suffix}.${extension}`

		const h = await directoryHandler.value.getFileHandle(fileName)
		const f = await h.getFile()
		return f
	}

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

	return {
		data,
		history,
		pauseHistory,
		pushHistory,
		hasModified,
		open,
		save,
		captureFrame,
		allFrames,
	}
}
