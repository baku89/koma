/**
 * Exhibition screen data (ADDSUB.md §15.2): reads the shooting machine's koma
 * project folder — synced to this machine by Dropbox — directly through the
 * File System Access API. Read-only. The folder handle is persisted in
 * IndexedDB so a reboot only needs the one-time (or "always allow")
 * permission, never a picker.
 *
 * project.json is polled; a half-synced file fails to parse and is retried.
 * Frame images are the project's `_lv` previews, read lazily around the
 * playhead and detached from the file (Dropbox may replace it under us).
 */

import {del, get, set} from 'idb-keyval'
import {computed, reactive, readonly, ref, shallowRef} from 'vue'

const HANDLE_KEY = 'com.baku89.koma.exhibit.projectDir'
const POLL_MS = 4000

type BlobRef = {$type: 'blob'; filename: string} | string

interface RawShot {
	lv: BlobRef
	jpg: BlobRef
	captureDate?: number
	shootTime?: number
	cameraConfigs?: Record<string, unknown>
	rig?: Record<string, number>
	mill?: Record<string, number>
	kBase?: number
	previzFrame?: number
	led?: {file: string}
}

interface RawTrashed {
	shot: RawShot
	frame: number
	layer: number
	deletedAt: number
}

interface RawProject {
	name: string
	fps: number
	komas: ({shots: (RawShot | null)[]} | null)[]
	trash?: RawTrashed[]
	previewRange?: [number, number]
	captureShot?: {frame: number; layer: number}
	layers?: {id?: string; name?: string}[]
	addsub?: {
		kBase?: number
		parkLayer?: number
		sequence?: {
			frame: number
			step: string
			done: string[]
			status: string
			error?: string
			updatedAt: number
		} | null
	}
}

export interface ExhibitFrame {
	frame: number
	layer: number
	/** Live on the timeline, or a discarded take kept in _trash. */
	take: 'live' | 'trash'
	filename: string
	captureDate?: number
	cameraConfigs?: Record<string, unknown>
	rig?: Record<string, number>
	kBase?: number
	previzFrame?: number
	led?: string
}

function refFilename(r: BlobRef | undefined): string | null {
	if (!r) return null
	return typeof r === 'string' ? r : r.filename
}

const dir = shallowRef<FileSystemDirectoryHandle | null>(null)
const permission = ref<'granted' | 'prompt' | 'denied' | 'none'>('none')
const project = shallowRef<RawProject | null>(null)
const lastModified = ref<number | null>(null)
const error = ref<string | null>(null)
const state = reactive({polling: false})

/** Index (into `frames`) of the frame screen A is showing right now. */
const shownIndex = ref(0)

let pollTimer: ReturnType<typeof setInterval> | null = null

/**
 * Every take ever shot — all layers (film, tests, replays, park…) and the
 * discarded ones in the trash — in the order they were shot. This is what
 * screen A loops: the whole history of the piece, not just the film.
 */
const frames = computed<ExhibitFrame[]>(() => {
	const p = project.value
	if (!p) return []
	const out: ExhibitFrame[] = []
	const push = (shot: RawShot, frame: number, layer: number, take: 'live' | 'trash', dir = '') => {
		const filename = refFilename(shot.lv)
		if (!filename) return
		out.push({
			frame,
			layer,
			take,
			filename: dir ? `${dir}/${filename}` : filename,
			captureDate: shot.captureDate,
			cameraConfigs: shot.cameraConfigs,
			rig: shot.rig,
			kBase: shot.kBase,
			previzFrame: shot.previzFrame,
			led: shot.led?.file,
		})
	}
	p.komas.forEach((koma, frame) => {
		koma?.shots?.forEach((shot, layer) => {
			if (shot) push(shot, frame, layer, 'live')
		})
	})
	for (const t of p.trash ?? []) {
		if (t?.shot) push(t.shot, t.frame, t.layer, 'trash', '_trash')
	}
	// Chronological; takes without a date go last in timeline order.
	return out
		.map((f, i) => ({f, i}))
		.sort((a, b) => {
			const da = a.f.captureDate ?? Infinity
			const db = b.f.captureDate ?? Infinity
			return da === db ? a.i - b.i : da - db
		})
		.map(({f}) => f)
})

/** Cheap identity of the take list, to know when the video must be rebuilt. */
const framesSignature = computed(() => {
	const fs = frames.value
	return `${fs.length}:${fs[0]?.filename ?? ''}:${fs[fs.length - 1]?.filename ?? ''}:${fs[fs.length - 1]?.captureDate ?? ''}`
})

const fps = computed(() => project.value?.fps ?? 18)

const shown = computed<ExhibitFrame | null>(() => frames.value[shownIndex.value] ?? null)

//------------------------------------------------------------------------------
// Folder

async function restore() {
	try {
		const h = (await get(HANDLE_KEY)) as FileSystemDirectoryHandle | undefined
		if (!h) return
		dir.value = h
		permission.value = await h.queryPermission({mode: 'read'})
		if (permission.value === 'granted') startPolling()
	} catch (e) {
		error.value = e instanceof Error ? e.message : String(e)
	}
}

/** Needs a user gesture. */
async function requestPermission() {
	const h = dir.value
	if (!h) return
	permission.value = await h.requestPermission({mode: 'read'})
	if (permission.value === 'granted') startPolling()
}

/** Needs a user gesture. */
async function pick() {
	try {
		const h = await window.showDirectoryPicker({id: 'exhibit', mode: 'read'})
		await set(HANDLE_KEY, h)
		dir.value = h
		permission.value = 'granted'
		project.value = null
		lastModified.value = null
		startPolling()
	} catch {
		// cancelled
	}
}

async function forget() {
	stopPolling()
	await del(HANDLE_KEY)
	dir.value = null
	project.value = null
	permission.value = 'none'
}

function startPolling() {
	stopPolling()
	void poll()
	pollTimer = setInterval(() => void poll(), POLL_MS)
}

function stopPolling() {
	if (pollTimer) clearInterval(pollTimer)
	pollTimer = null
}

async function poll() {
	const h = dir.value
	if (!h || state.polling) return
	state.polling = true
	try {
		const fh = await h.getFileHandle('project.json')
		const f = await fh.getFile()
		if (f.lastModified === lastModified.value) return
		for (let attempt = 0; attempt < 4; attempt++) {
			try {
				const text = await (attempt === 0 ? f : await fh.getFile()).text()
				project.value = JSON.parse(text) as RawProject
				lastModified.value = f.lastModified
				error.value = null
				return
			} catch (e) {
				// Probably mid-sync — wait a moment and read again.
				error.value = 'project.json is being written… retrying'
				await new Promise(r => setTimeout(r, 500))
				if (e instanceof DOMException) break
			}
		}
	} catch (e) {
		error.value = e instanceof Error ? e.message : String(e)
	} finally {
		state.polling = false
	}
}

//------------------------------------------------------------------------------
// Frame images

const urlCache = new Map<string, string>()
const inflight = new Map<string, Promise<string | null>>()
const CACHE_LIMIT = 80

async function frameUrl(filename: string): Promise<string | null> {
	const cached = urlCache.get(filename)
	if (cached) {
		// Refresh LRU order.
		urlCache.delete(filename)
		urlCache.set(filename, cached)
		return cached
	}
	const pending = inflight.get(filename)
	if (pending) return pending
	const p = (async () => {
		const h = dir.value
		if (!h) return null
		try {
			const fh = await getFileHandle(h, filename)
			const f = await fh.getFile()
			const blob = new Blob([await f.arrayBuffer()], {type: f.type || 'image/jpeg'})
			const url = URL.createObjectURL(blob)
			urlCache.set(filename, url)
			while (urlCache.size > CACHE_LIMIT) {
				const [oldest, oldUrl] = urlCache.entries().next().value as [string, string]
				urlCache.delete(oldest)
				URL.revokeObjectURL(oldUrl)
			}
			return url
		} catch {
			return null
		} finally {
			inflight.delete(filename)
		}
	})()
	inflight.set(filename, p)
	return p
}

async function getFileHandle(root: FileSystemDirectoryHandle, rel: string) {
	const parts = rel.split('/').filter(Boolean)
	let d = root
	for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part)
	return d.getFileHandle(parts[parts.length - 1])
}

/** Read a take's preview bytes (not cached as a URL). */
async function frameBlob(filename: string): Promise<Blob | null> {
	const h = dir.value
	if (!h) return null
	try {
		const fh = await getFileHandle(h, filename)
		const f = await fh.getFile()
		return new Blob([await f.arrayBuffer()], {type: f.type || 'image/jpeg'})
	} catch {
		return null
	}
}

export function useExhibitStore() {
	return {
		dir: readonly(dir),
		permission: readonly(permission),
		project: readonly(project),
		frames,
		framesSignature,
		fps,
		shownIndex,
		shown,
		error: readonly(error),
		restore,
		requestPermission,
		pick,
		forget,
		frameUrl,
		frameBlob,
	}
}
