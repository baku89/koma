import {
	asyncComputed,
	pausableWatch,
	useRefHistory,
	whenever,
} from '@vueuse/core'
import {useIDBKeyval} from '@vueuse/integrations/useIDBKeyval'
import {mat2d, quat, vec2, vec3} from 'linearly'
import {clamp, cloneDeep, debounce} from 'lodash-es'
import sleep from 'p-sleep'
import {defineStore} from 'pinia'
import {ConfigType, TethrIdentifier} from 'tethr'
import {computed, nextTick, reactive, ref, toRaw, toRefs} from 'vue'

import {
	assignReactive,
	clearAssets,
	debounceAsync,
	deepMergeExceptArray,
	frameAssetFilename,
	getAssetFilename,
	openJson,
	preventConcurrentExecution,
	queryPermission,
	readFileFromDirectory,
	reconcileAssets,
	registerDiskAsset,
	registerTrashedAsset,
	saveJson,
	showReadwriteDirectoryPicker,
	TRASH_DIR,
	writeFileToDirectory,
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

/**
 * Identity of the camera last used to shoot this project, persisted so the app
 * can auto-reconnect to the same device on reopen. This is Tethr's own
 * descriptor (USB serial pins the exact body; webcams can't be told apart).
 */
export type CameraIdentity = TethrIdentifier

interface Project {
	name: string
	fps: number
	captureShot: {frame: number; layer: number}
	previewRange: [number, number]
	onionskin: number
	komas: Koma[]
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
		src?: Blob
		startFrame: number
	}
	markers: Marker[]
	camera?: CameraIdentity
	/**
	 * Every shot that has been displaced from the timeline (deleted, or replaced by
	 * a re-shoot) and not yet purged. Intentionally NOT part of UndoableData: it is
	 * a monotonic ledger maintained by syncTrash() as the derived set
	 * "ever-captured − currently-live", so undo/redo *swaps* a shot between live and
	 * trash rather than ever destroying it. The bytes stay in the project's `_trash`
	 * folder, restorable later (Dragonframe-style).
	 */
	trash: TrashedShot[]
}

type UndoableData = Pick<Project, 'komas' | 'captureShot' | 'markers'> & {
	drawing?: PaperJSData
}

type SVGString = string
type PaperJSData = ReturnType<typeof JSON.parse>
type JSCode = string

type CameraConfigs = Partial<ConfigType>

export interface Koma {
	shots: (Shot | null)[]
	backupShots?: Shot[]
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

export interface Shot {
	/** Asset ids (see utils/assets) — resolve to bytes via resolveBlob/resolveAssetUrl. */
	lv: string
	jpg: string
	raw?: string
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

/** A shot kept in the project's trash, with where it used to live and when it was
 *  displaced. `shot` carries all its original metadata (shootTime, captureDate,
 *  cameraConfigs, tracker, dmx) plus the asset ids now pointing into `_trash`. */
export interface TrashedShot {
	shot: Shot
	/** Frame (koma index) it occupied when displaced. */
	frame: number
	/** Layer it occupied when displaced. */
	layer: number
	/** When it was last displaced from the timeline (ms epoch). */
	deletedAt: number
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
	camera: undefined,
	trash: [],
}

type BlobRef = {$type: 'blob'; filename: string}

function refFilename(ref: unknown): string | undefined {
	if (typeof ref === 'string') return ref
	if (ref && typeof ref === 'object' && (ref as BlobRef).$type === 'blob') {
		return (ref as BlobRef).filename
	}
	return undefined
}

// Tracks the directory each audio Blob already exists in, so autosave doesn't
// rewrite a (potentially large) audio file on every tick — and, on load, so the
// first save doesn't overwrite the audio file with itself.
const audioSavedDir = new WeakMap<Blob, FileSystemDirectoryHandle>()

/**
 * Read project.json and turn every on-disk image reference into a session asset
 * id (registered lazily — no bytes are read here, which is what makes open
 * fast). Audio is kept as a real Blob, read directly from the folder.
 */
async function loadProject(dir: FileSystemDirectoryHandle): Promise<Project> {
	const json: any = await openJson(dir, 'project.json')

	const loadShot = (shot: any): Shot | null => {
		if (!shot) return null
		return {
			...shot,
			lv: registerDiskAsset(refFilename(shot.lv)!, dir),
			jpg: registerDiskAsset(refFilename(shot.jpg)!, dir),
			raw:
				refFilename(shot.raw) !== undefined
					? registerDiskAsset(refFilename(shot.raw)!, dir)
					: undefined,
		}
	}

	const komas: Koma[] = (json.komas ?? []).map((koma: any) =>
		!koma
			? koma
			: {
					...koma,
					shots: (koma.shots ?? []).map(loadShot),
					backupShots: koma.backupShots?.map(loadShot),
				}
	)

	let audio = json.audio
	const audioFile = refFilename(audio?.src)
	if (audioFile !== undefined) {
		// Detach audio into memory so its object URL can't break when the file is
		// touched, and record that this copy already exists on disk so the first
		// autosave doesn't rewrite it over itself.
		const file = await readFileFromDirectory(dir, audioFile)
		const src = new Blob([await file.arrayBuffer()], {type: file.type})
		audioSavedDir.set(src, dir)
		audio = {...audio, src}
	}

	// Trash: register each displaced shot's bytes against the `_trash` subfolder so
	// they resolve lazily, exactly like live frames. A missing folder (or empty
	// list) just yields an empty trash.
	let trash: TrashedShot[] = []
	if (Array.isArray(json.trash) && json.trash.length > 0) {
		let trashDir: FileSystemDirectoryHandle | undefined
		try {
			trashDir = await dir.getDirectoryHandle(TRASH_DIR)
		} catch {
			trashDir = undefined
		}
		if (trashDir) {
			const loadTrashedShot = (shot: any): Shot => ({
				...shot,
				lv: registerTrashedAsset(refFilename(shot.lv)!, trashDir!),
				jpg: registerTrashedAsset(refFilename(shot.jpg)!, trashDir!),
				raw:
					refFilename(shot.raw) !== undefined
						? registerTrashedAsset(refFilename(shot.raw)!, trashDir!)
						: undefined,
			})
			trash = json.trash
				.filter((t: any) => t && t.shot)
				.map((t: any) => ({
					shot: loadTrashedShot(t.shot),
					frame: t.frame ?? 0,
					layer: t.layer ?? 0,
					deletedAt: t.deletedAt ?? 0,
				}))
		}
	}

	return {...json, komas, audio, trash}
}

function audioFilename(src: Blob): string {
	let filename = 'audio.src'
	if (src instanceof File && src.name.includes('.')) {
		const ext = src.name.split('.').pop()
		if (ext) filename += `.${ext}`
	}
	return filename
}

/**
 * Bring the on-disk filenames in line with the current timeline: live frames get
 * their sequential names (byte-free rename via move()), files that are no longer
 * referenced are moved into _trash. Runs before project.json is written.
 */
async function reconcileProjectAssets(
	dir: FileSystemDirectoryHandle,
	project: Project
) {
	const desired: {id: string; name: string}[] = []
	const protectedIds = new Set<string>()

	const pushLive = (
		id: string | undefined,
		frame: number,
		layer: number,
		type: 'lv' | 'jpg' | 'raw'
	) => {
		if (!id) return
		protectedIds.add(id)
		desired.push({id, name: frameAssetFilename(project.name, layer, frame, type)})
	}

	// Backup shots have no timeline slot, so keep their current name — but still
	// protect them from being trashed (and persist any unwritten bytes).
	const pushKeep = (id: string | undefined) => {
		if (!id) return
		protectedIds.add(id)
		const name = getAssetFilename(id)
		if (name) desired.push({id, name})
	}

	project.komas.forEach((koma, frame) => {
		if (!koma) return
		koma.shots.forEach((shot, layer) => {
			if (!shot) return
			pushLive(shot.lv, frame, layer, 'lv')
			pushLive(shot.jpg, frame, layer, 'jpg')
			pushLive(shot.raw, frame, layer, 'raw')
		})
		koma.backupShots?.forEach(shot => {
			pushKeep(shot.lv)
			pushKeep(shot.jpg)
			pushKeep(shot.raw)
		})
	})

	// Trashed shots are deliberately NOT protected (so step 1 moves freshly
	// displaced files into _trash), but their ids are handed over so any captured-
	// but-never-saved bytes still get written there.
	const trashedIds: string[] = []
	project.trash.forEach(({shot}) => {
		if (shot.lv) trashedIds.push(shot.lv)
		if (shot.jpg) trashedIds.push(shot.jpg)
		if (shot.raw) trashedIds.push(shot.raw)
	})

	await reconcileAssets(dir, desired, protectedIds, trashedIds)
}

/**
 * Write project.json, replacing each asset id with its `{$type:'blob', filename}`
 * reference (json format unchanged for backward compatibility). The bytes are
 * already on disk at the right names by the time this runs (reconcile above).
 */
async function saveProject(dir: FileSystemDirectoryHandle, project: Project) {
	await reconcileProjectAssets(dir, project)

	const refOf = (id: string | undefined): BlobRef | undefined => {
		if (id === undefined) return undefined
		const filename = getAssetFilename(id)
		return filename === undefined ? undefined : {$type: 'blob', filename}
	}
	const saveShot = (shot: Shot | null) =>
		!shot
			? null
			: {
					...shot,
					lv: refOf(shot.lv),
					jpg: refOf(shot.jpg),
					raw: refOf(shot.raw),
				}

	const komas = project.komas.map(koma =>
		!koma
			? koma
			: {
					...koma,
					shots: (koma.shots ?? []).map(saveShot),
					backupShots: koma.backupShots?.map(saveShot),
				}
	)

	let audio: any = project.audio
	if (audio?.src instanceof Blob) {
		const filename = audioFilename(audio.src)
		if (audioSavedDir.get(audio.src) !== dir) {
			await writeFileToDirectory(dir, filename, audio.src)
			audioSavedDir.set(audio.src, dir)
		}
		audio = {...audio, src: {$type: 'blob', filename}}
	}

	// The trashed shots' bytes are already in _trash (reconcile above), so refOf
	// resolves each id to its current `_trash` filename.
	const trash = project.trash.map(t => ({...t, shot: saveShot(t.shot)}))

	await saveJson(dir, 'project.json', {...project, komas, audio, trash})
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

	// Saved to a real filesystem folder (true) vs an in-app OPFS project (false).
	const isSavedToDisk = asyncComputed(async () => {
		if (!directoryHandle.value) return false
		return !(await opfs.isWithinLocal(directoryHandle.value))
	})

	// Recently-opened projects (both FS folders and in-app), persisted by handle
	// so they survive reloads — same mechanism as directoryHandle above.
	type RecentProject = {
		handle: FileSystemDirectoryHandle
		name: string
		type: 'fs' | 'opfs'
		lastOpened: number
	}

	const {data: recentProjects} = useIDBKeyval<RecentProject[]>(
		'com.baku89.koma.recentProjects',
		[],
		{shallow: true}
	)

	const RECENT_LIMIT = 10

	async function rememberProject(
		handle: FileSystemDirectoryHandle,
		name: string
	) {
		const type = (await opfs.isWithinLocal(handle)) ? 'opfs' : 'fs'

		// Drop any existing entry pointing at the same directory, then prepend.
		const kept: RecentProject[] = []
		for (const e of recentProjects.value) {
			if (await e.handle.isSameEntry(handle)) continue
			kept.push(e)
		}
		kept.unshift({handle, name, type, lastOpened: Date.now()})
		recentProjects.value = kept.slice(0, RECENT_LIMIT)
	}

	async function openRecent(entry: RecentProject) {
		try {
			if (entry.type === 'fs') {
				await queryPermission(entry.handle)
			}
			await open(entry.handle)
		} catch {
			// Handle revoked / folder gone — forget it.
			recentProjects.value = recentProjects.value.filter(p => p !== entry)
			alert(`Could not open "${entry.name}".`)
		}
	}

	function todayName(): string {
		const d = new Date()
		return (
			`${d.getFullYear()}-` +
			`${String(d.getMonth() + 1).padStart(2, '0')}-` +
			`${String(d.getDate()).padStart(2, '0')}`
		)
	}

	// `base`, or `base_2`, `base_3`… if an in-app project of that name exists.
	async function uniqueProjectDirName(base: string): Promise<string> {
		const existing = new Set(
			(await opfs.listProjectDirs()).map(dir => dir.name)
		)
		if (!existing.has(base)) return base
		let i = 2
		while (existing.has(`${base}_${i}`)) i++
		return `${base}_${i}`
	}

	async function defaultProjectName(): Promise<string> {
		return uniqueProjectDirName(todayName())
	}

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

	// An "ephemeral" project is a fresh in-memory one that has NOT been written to
	// disk yet — opening the app or hitting Create New starts here. We only
	// materialize it (create the OPFS dir, autosave, add to recents) once the user
	// makes a meaningful content change, so merely opening the app (or panning /
	// zooming) never litters "Saved to App" with empty projects.
	let ephemeral = false

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

	// True when there are edits not yet persisted to disk. Drives the unsaved
	// indicator and the beforeunload guard so a reload mid re-sequence warns.
	const dirty = ref(false)

	// The live shots (keyed by their lv asset id) as of the last settle. syncTrash
	// diffs this against the current timeline to discover what was displaced — the
	// step that lets it capture a shot an undo/redo swapped out *before* the
	// wholesale state replacement erases it. Rebuilt on open()/createNew().
	type LiveShot = {shot: Shot; frame: number; layer: number}
	let prevLiveShots = new Map<string, LiveShot>()

	function liveShotIndex(): Map<string, LiveShot> {
		const live = new Map<string, LiveShot>()
		project.komas.forEach((koma, frame) => {
			if (!koma) return
			koma.shots.forEach((shot, layer) => {
				if (shot) live.set(shot.lv, {shot, frame, layer})
			})
			// Backup shots aren't on the timeline but must never be trashed either.
			koma.backupShots?.forEach(shot => {
				if (shot) live.set(shot.lv, {shot, frame: -1, layer: -1})
			})
		})
		return live
	}

	/**
	 * Maintain `project.trash` as the derived set "ever-captured − currently-live":
	 * a shot that just left the timeline (delete, re-shoot overwrite, or an undo
	 * that swapped it out) is appended; a shot a redo/undo brought back live is
	 * reclaimed. Because nothing is ever destroyed here, a captured shot survives
	 * any history navigation until an explicit purge.
	 *
	 * Idempotent: only mutates project.trash when the live set actually changed, so
	 * the autosave watcher's re-fire (triggered by that very mutation) converges on
	 * the next pass instead of looping.
	 */
	function syncTrash() {
		const newLive = liveShotIndex()
		const trashed = new Set(project.trash.map(t => t.shot.lv))

		for (const [id, info] of prevLiveShots) {
			if (newLive.has(id) || trashed.has(id)) continue
			project.trash.push({
				shot: cloneDeep(toRaw(info.shot)),
				frame: info.frame,
				layer: info.layer,
				deletedAt: Date.now(),
			})
		}

		const kept = project.trash.filter(t => !newLive.has(t.shot.lv))
		if (kept.length !== project.trash.length) {
			project.trash = kept
		}

		prevLiveShots = newLive
	}

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
		// Flush the current project first (if any — none on a cold start). Nothing
		// is lost on switch: in-app projects autosave to their own subdir and stay
		// in the recent list, so no destructive confirmation is needed.
		if (directoryHandle.value) await save()

		clearAssets()
		await startEphemeralProject()

		nextTick(() => history.clear())
	}

	// A fresh, not-yet-persisted in-app project held only in memory. No OPFS
	// directory is created until materializeEphemeral() runs on the first
	// meaningful edit, so opening the app (or just panning/zooming) never leaves
	// an empty project behind.
	async function startEphemeralProject() {
		assignReactive(project, cloneDeep(emptyProject))
		project.name = await defaultProjectName()
		directoryHandle.value = null
		prevLiveShots = liveShotIndex()
		projectLoaded = true
		ephemeral = true
	}

	// First meaningful edit on an ephemeral project: give it a real OPFS directory,
	// bind autosave to it, and remember it.
	async function materializeEphemeral() {
		ephemeral = false
		const name = await uniqueProjectDirName(project.name || todayName())
		const dir = await opfs.createProjectDir(name)
		directoryHandle.value = dir
		project.name = name
		await rememberProject(dir, name)
	}

	// Whether the project carries content worth persisting (captured/imported
	// frames, markers, a timeline drawing, or audio). View-state — zoom/pan, the
	// capture cursor — deliberately doesn't count.
	function hasContent(p: Project): boolean {
		if (
			p.komas.some(
				k => k && (k.shots.some(Boolean) || (k.backupShots?.length ?? 0) > 0)
			)
		) {
			return true
		}
		if (p.markers.length > 0) return true
		if (p.timeline.drawing) return true
		if (p.audio?.src) return true
		return false
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

			// Drop the previous project's asset ids/URLs before registering the
			// new ones during load.
			clearAssets()

			const unflatProject = await loadProject(directoryHandle.value)

			// In case the latest project format has more properties than the saved one,
			// merge the saved state with the default state
			const mergedProject = deepMergeExceptArray(unflatProject, emptyProject)

			autoSave.pause()
			assignReactive(project, mergedProject)
			// Seed the live-shot baseline from the freshly loaded timeline so the
			// first edit diffs against it rather than against a stale set.
			prevLiveShots = liveShotIndex()
			autoSave.resume()

			// Load succeeded — autosave may now persist changes to this directory.
			projectLoaded = true
			ephemeral = false

			await rememberProject(directoryHandle.value, project.name)

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
		ephemeral = false
		await rememberProject(handle, project.name)
		save()
	}

	const {fn: save, isExecuting: isSaving} = debounceAsync(
		async () => {
			if (isOpening.value) return

			if (!directoryHandle.value) {
				throw new Error('No directory is specified')
			}

			await saveProject(directoryHandle.value, toRaw(project))
		},
		{
			// Fires only once the whole (possibly re-queued) save chain settles, so
			// dirty stays true if more edits land mid-save.
			onFinish: () => {
				dirty.value = false
			},
		}
	)

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
	const requestAutoSave = debounce(async () => {
		if (!projectLoaded) return
		if (autosaveSuspendDepth.value > 0) return // re-armed when the burst ends
		if (ephemeral) {
			// Don't persist (or create a directory) until there's real content.
			if (!hasContent(project)) return
			await materializeEphemeral()
		}
		save()
	}, 500)

	// Same trick as undoableData: while a burst is in progress the source
	// collapses to a constant so this watcher stops deep-traversing the whole
	// project on every change. (pausableWatch's pause would only skip the save
	// callback, not the traversal.) The pausableWatch handle is still used by
	// open() below.
	const autoSave = pausableWatch(
		() => (autosaveSuspendDepth.value > 0 ? null : project),
		() => {
			// An ephemeral project with no real content yet isn't "dirty" — leaving
			// it that way would flag unsaved changes (and warn on unload) for a blank
			// just-opened app.
			if (projectLoaded && (!ephemeral || hasContent(project))) {
				dirty.value = true
				// Capture anything just displaced from the timeline into trash before
				// the next save persists it. Runs only outside bursts (the source is
				// collapsed during one), and bursts never change shots anyway.
				syncTrash()
			}
			requestAutoSave()
		},
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

	whenever(isDirectoryHandlePersisted, async () => {
		let handle = directoryHandle.value

		// A persisted pointer at the `local/` container itself is the pre-migration
		// in-app project; redirect to the (migrated) subdirectory.
		if (handle && (await opfs.isLocalContainer(handle))) {
			const dirs = await opfs.listProjectDirs()
			handle = dirs[0] ?? null
			directoryHandle.value = handle
		}

		if (handle) {
			open(handle)
		} else {
			// No previous project — start a fresh, not-yet-persisted one (a project
			// directory is only created once the user makes a real edit).
			startEphemeralProject()
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

	// ---- In-App Projects management (Preferences → In-App Projects) -----------

	type InAppProject = {
		handle: FileSystemDirectoryHandle
		dirName: string
		name: string
		size: number
		current: boolean
	}

	async function listInAppProjects(): Promise<InAppProject[]> {
		const dirs = await opfs.listProjectDirs()
		const current = directoryHandle.value
		const out: InAppProject[] = []
		for (const dir of dirs) {
			let name = dir.name
			try {
				const text = await (
					await readFileFromDirectory(dir, 'project.json')
				).text()
				const json = JSON.parse(text)
				if (typeof json.name === 'string') name = json.name
			} catch {
				// No project.json yet — fall back to the directory name.
			}
			out.push({
				handle: dir,
				dirName: dir.name,
				name,
				size: await opfs.dirSize(dir),
				current: current ? await dir.isSameEntry(current) : false,
			})
		}
		return out
	}

	async function forgetRecent(handle: FileSystemDirectoryHandle) {
		const kept: RecentProject[] = []
		for (const e of recentProjects.value) {
			if (await e.handle.isSameEntry(handle)) continue
			kept.push(e)
		}
		recentProjects.value = kept
	}

	async function patchProjectName(
		dir: FileSystemDirectoryHandle,
		name: string
	) {
		try {
			const text = await (
				await readFileFromDirectory(dir, 'project.json')
			).text()
			const json = JSON.parse(text)
			json.name = name
			await writeFileToDirectory(
				dir,
				'project.json',
				new Blob([JSON.stringify(json)])
			)
		} catch {
			// No project.json to patch.
		}
	}

	async function deleteInAppProject(entry: InAppProject) {
		// Move off the current project first so autosave can't recreate it.
		if (entry.current) {
			const others = (await opfs.listProjectDirs()).filter(
				d => d.name !== entry.dirName
			)
			if (others.length > 0) {
				await open(others[0])
			} else {
				clearAssets()
				await startEphemeralProject()
			}
		}
		await opfs.deleteProjectDir(entry.dirName)
		await forgetRecent(entry.handle)
	}

	async function renameInAppProject(entry: InAppProject, rawName: string) {
		const newName = rawName.trim()
		if (!newName || newName === entry.dirName) return
		const unique = await uniqueProjectDirName(newName)

		await forgetRecent(entry.handle)
		const newDir = await opfs.renameProjectDir(entry.dirName, unique)
		await patchProjectName(newDir, unique)

		if (entry.current) {
			// Rebind + reload from the renamed directory (fresh asset store).
			await open(newDir)
		} else {
			await rememberProject(newDir, unique)
		}
	}

	async function exportInAppProjectToFolder(entry: InAppProject) {
		const target = await showReadwriteDirectoryPicker()
		await opfs.copyDirContents(entry.handle, target)

		const wasCurrent = entry.current
		await forgetRecent(entry.handle)
		await opfs.deleteProjectDir(entry.dirName)

		if (wasCurrent) {
			// Reload from the filesystem copy; autosave now targets the real folder.
			await open(target)
		} else {
			await rememberProject(target, entry.name)
		}
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
		recentProjects,
		openRecent,
		listInAppProjects,
		deleteInAppProject,
		renameInAppProject,
		exportInAppProjectToFolder,
		allKomas,
		previewKomas,
		setInPoint,
		setOutPoint,
		isOpening,
		isSaving,
		dirty,
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
