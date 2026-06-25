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
import {computed, nextTick, reactive, ref, toRaw, toRefs} from 'vue'

import {
	assignReactive,
	debounceAsync,
	deepMergeExceptArray,
	openBlobJson,
	preventConcurrentExecution,
	queryPermission,
	readFileFromDirectory,
	saveBlobJson,
	showReadwriteDirectoryPicker,
} from '@/utils'

import defaultCustomScript from './defaultCustomScript.js?raw'
import defaultPreShootScript from './defaultPreShootScript.js?raw'
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
	/**
	 * A script executed right before the shutter opens on every shot. The
	 * Promise it returns is awaited and then capture begins immediately, so it
	 * can kick off frame-dependent CNC motion (e.g. an LED light streak) and
	 * resolve as soon as the (long) exposure should start.
	 */
	preShootScript: JSCode
	/**
	 * A user-defined script runnable on demand from the Command Palette
	 * ("Run Custom Script"). Receives the same context as the pre-shoot script,
	 * so it can e.g. send the current frame's G-code to the CNC at any time.
	 */
	customScript: JSCode
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

export interface Koma<T = Blob> {
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
	preShootScript: defaultPreShootScript.slice(1),
	customScript: defaultCustomScript.slice(1),
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

	// True only once a project has been successfully loaded into `project`, or an
	// explicit createNew()/saveAs() has set up a fresh one. Autosave is gated on
	// this so a failed or partial open() can never persist the empty default over
	// a real project.json. This is the fix for the data-loss bug where a
	// cold-start permission prompt (restored FS handle starts in the "prompt"
	// state, with no user gesture to grant it) or a single missing referenced
	// file made openBlobJson throw, left `project` as the empty default, and the
	// next autosave then wiped the real file on disk.
	let projectLoaded = false

	// The autosave and history watchers below deep-watch the whole project /
	// undoable state. @vueuse's pause() only gates their callback (save /
	// cloneDeep) — the underlying deep `watch` still re-traverses the source on
	// every change, and that O(komas) traversal is what makes continuous edits
	// (marker drag, timeline zoom, …) crawl on large projects. So instead of
	// pausing, we collapse each watcher's *source* to a constant during a burst,
	// which unsubscribes it from `project`/`komas` entirely until the burst ends.
	//
	// Two independent controls, because not every continuous change is undoable:
	//   - autosaveSuspendDepth: a counter (gestures can overlap, e.g. wheel-zoom
	//     while dragging) that collapses the autosave source while > 0.
	//   - historyBatching: collapses the history source; only set by the undoable
	//     begin/endInteraction pair, which also commits one entry on end.
	const autosaveSuspendDepth = ref(0)
	const historyBatching = ref(false)

	const undoableData = computed<UndoableData>({
		get() {
			// Collapse to a constant mid-interaction so the history watcher doesn't
			// re-traverse komas on every drag tick. The single end-of-drag snapshot
			// is taken by endInteraction()'s history.resume(true).
			if (historyBatching.value) return null as unknown as UndoableData
			return {
				captureShot: project.captureShot,
				komas: project.komas,
				markers: project.markers,
				drawing: project.timeline.drawing,
			}
		},
		set(data) {
			if (!data) return
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
		projectLoaded = true

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

			// Block autosave until this load fully succeeds, so a failure midway
			// (permission prompt, missing file) can't trigger an empty overwrite.
			projectLoaded = false

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

			// Load succeeded — autosave may now persist changes to this directory.
			projectLoaded = true

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
		projectLoaded = true
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
	//
	// Gated on `projectLoaded`: until open()/createNew()/saveAs() has
	// successfully established a project, autosave does nothing. This prevents
	// the empty default from being written over a real project.json when a
	// cold-start open() fails (permission prompt, missing referenced file, etc.).
	//
	// Also gated on `autosaveSuspendDepth`: saveBlobJson() walks the whole project
	// and JSON.stringify()s it synchronously. If that lands in the middle of a
	// continuous interaction (drawing a stroke, zooming the timeline) it stalls
	// the main thread, drops events, and leaves artifacts. While a burst is in
	// progress we suppress autosave and persist once it ends instead.
	const requestAutoSave = debounce(() => {
		if (!projectLoaded) return
		if (autosaveSuspendDepth.value > 0) return // re-armed when the burst ends
		save()
	}, 500)

	// Same trick as undoableData: while a burst is in progress the source
	// collapses to a constant so this watcher stops deep-traversing the whole
	// project on every change. (pausableWatch's pause would only skip the save
	// callback, not the traversal.) The pausableWatch handle is still used by
	// open() below.
	const autoSave = pausableWatch(
		() => (autosaveSuspendDepth.value > 0 ? null : project),
		requestAutoSave,
		{deep: true}
	)

	/**
	 * Bracket a continuous, *undoable* pointer interaction (marker / drawing
	 * drag). Suspends both autosave and history deep-tracking; endInteraction
	 * records exactly one history entry for the whole gesture.
	 */
	function beginInteraction() {
		// Pause history commits *before* collapsing its source, so the collapse
		// can't record a bogus (null) snapshot.
		history.pause()
		historyBatching.value = true
		autosaveSuspendDepth.value++
		requestAutoSave.cancel() // drop a save queued by the previous interaction
	}

	function endInteraction() {
		// Flipping historyBatching back re-subscribes the history watcher to the
		// real (post-gesture) data, which schedules exactly one fire; resume()
		// un-gates it so that fire records a single entry for the whole gesture.
		// (resume(true) would *also* commit manually → a duplicate entry, because
		// unlike the usual pause/resume flow our source actually transitions here.)
		historyBatching.value = false
		history.resume()
		autosaveSuspendDepth.value--
		requestAutoSave()
	}

	/**
	 * Bracket a continuous *non-undoable* change (e.g. timeline zoom, which only
	 * writes project.timeline.zoomFactor). Suspends just the autosave traversal —
	 * history is untouched, so it neither records a no-op entry nor drops a real
	 * edit that happens to overlap. Safe to nest with begin/endInteraction.
	 */
	function beginAutosaveBatch() {
		autosaveSuspendDepth.value++
		requestAutoSave.cancel()
	}

	function endAutosaveBatch() {
		autosaveSuspendDepth.value--
		requestAutoSave()
	}

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
		value = clamp(value, 0, allKomas.value.length - 1)

		if (project.previewRange[1] < value) {
			project.previewRange = [value, value]
		} else {
			project.previewRange = [value, project.previewRange[1]]
		}
	}

	function setOutPoint(value: number) {
		value = clamp(value, 0, allKomas.value.length - 1)

		if (value < project.previewRange[0]) {
			project.previewRange = [value, value]
		} else {
			project.previewRange = [project.previewRange[0], value]
		}
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

	const duration = computed(() => {
		return project.komas.length
	})
	function setDuration(value: number) {
		while (value >= project.komas.length) {
			project.komas.push({shots: []})
		}
	}

	/**
	 * Reads a text file (e.g. per-frame G-code) from the current project folder.
	 * Rejects if the project has not been saved to a folder yet, or the file is
	 * missing. Exposed to the pre-shoot script.
	 */
	async function readProjectFile(filename: string): Promise<string> {
		if (!directoryHandle.value) {
			throw new Error('The project has not been saved to a folder yet')
		}
		const file = await readFileFromDirectory(directoryHandle.value, filename)
		return await file.text()
	}

	return {
		...toRefs(project),
		readProjectFile,
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
		beginInteraction,
		endInteraction,
		beginAutosaveBatch,
		endAutosaveBatch,
		shot,
		setShot,
		layer,
		layerCount,
		duration,
		setDuration,
	}
})
