/**
 * Exhibition screen data (ADDSUB.md §15.2). Read-only view of the koma
 * project, from one of two sources (see source.ts):
 *
 * - the display copy the shooting machine pushes to koma-relay — the normal
 *   case: the kiosk opens the page from the relay, nothing to pick or grant;
 *   a `file` message from the relay re-reads project.json at once;
 * - a folder through the File System Access API (handle persisted in
 *   IndexedDB), or an OPFS folder for tests.
 *
 * project.json is polled as well (a relay may be missing, a synced folder
 * may change under us); a half-written file fails to parse and is retried.
 * Frame images are the project's `_lv` previews, read lazily around the
 * playhead.
 */

import {del, get, set} from 'idb-keyval'
import {computed, reactive, readonly, ref, shallowRef, watch} from 'vue'

import {useExhibitRelay} from './relay'
import {DirSource, HttpSource, type ProjectSource} from './source'

const HANDLE_KEY = 'com.baku89.koma.exhibit.projectDir'
/**
 * Which source the user chose last: a picked folder ('dir') or the relay.
 * A folder picked on purpose must survive reloads even when a relay is
 * reachable (e.g. `?relay=` in the URL), otherwise it looks as if the
 * folder was never remembered. localStorage: cheap and synchronous.
 */
const SOURCE_PREF_KEY = 'com.baku89.koma.exhibit.sourcePref'
const POLL_MS = 4000
const PREVIZ_FRAMES = 'previz/frames.json'

type BlobRef = {$type: 'blob'; filename: string} | string

interface RawShot {
	lv: BlobRef
	jpg: BlobRef
	captureDate?: number
	shootTime?: number
	cameraConfigs?: Record<string, unknown>
	rig?: Record<string, number>
	mill?: Record<string, number>
	filmLift?: number
	/** Pre-filmLift files: base block index (lift = 60·kBase). */
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
	layerPresets?: {id: string; name: string; layers: {layerId: string}[]}[]
	addsub?: {
		filmLift?: number
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
	/**
	 * main: the film; previz: a not-yet-shot film frame filled from the previz
	 * layer; live: a take on another layer (test, replay, park…); trash: a
	 * discarded take kept in _trash.
	 */
	take: 'main' | 'previz' | 'live' | 'trash'
	filename: string
	captureDate?: number
	cameraConfigs?: Record<string, unknown>
	rig?: Record<string, number>
	filmLift?: number
	previzFrame?: number
	led?: string
}

function refFilename(r: BlobRef | undefined): string | null {
	if (!r) return null
	return typeof r === 'string' ? r : r.filename
}

const source = shallowRef<ProjectSource | null>(null)
/** For a folder source: whether it can be read right now. */
const permission = ref<'granted' | 'prompt' | 'denied' | 'none'>('none')
const project = shallowRef<RawProject | null>(null)
const projectVersion = ref<string | null>(null)

/** previz/frames.json (what Houdini wrote next to the project), if present. */
interface PrevizFile {
	paths?: {gcode?: string}
	frames: {frame: number; gcode?: string; cut?: boolean}[]
}
const previzFile = shallowRef<PrevizFile | null>(null)
const previzVersion = ref<string | null>(null)
/** Bumped whenever previz/frames.json changed (consumers re-read G-code). */
const previzModified = ref<number | null>(null)
/**
 * Text files read through `readText` (G-code shown on screen B). LRU: every
 * shown take has its own NC file (tens to hundreds of KB), and a loop over
 * thousands of takes would otherwise keep all of them.
 */
const textCache = new Map<string, Promise<string | null>>()
const TEXT_CACHE_LIMIT = 100
const error = ref<string | null>(null)
const state = reactive({polling: false})

/** Index (into `frames`) of the frame screen A is showing right now. */
const shownIndex = ref(0)

let pollTimer: ReturnType<typeof setInterval> | null = null

const relay = useExhibitRelay()

/**
 * Which storage layers the exhibition shows: the layers of a preset named
 * "Exhibit" when the project has one (so previz / reference layers can be
 * left out from koma's Layers dialog), otherwise every layer.
 */
function exhibitLayers(p: RawProject): Set<number> | null {
	const preset = p.layerPresets?.find(pr => /^exhibit$/i.test(pr.name.trim()))
	if (!preset || !p.layers) return null
	const set = new Set<number>()
	for (const v of preset.layers) {
		const i = p.layers.findIndex(l => l.id === v.layerId)
		if (i !== -1) set.add(i)
	}
	return set
}

/**
 * Previz / reference layers: a preset named "Previz" when present, else any
 * layer whose name mentions previz. Never part of the loop; screen B shows
 * the previz frame matching the take being played.
 */
function previzLayerIndices(p: RawProject): number[] {
	const preset = p.layerPresets?.find(pr => /^previz$/i.test(pr.name.trim()))
	if (preset && p.layers) {
		return preset.layers
			.map(v => p.layers!.findIndex(l => l.id === v.layerId))
			.filter(i => i !== -1)
	}
	return (p.layers ?? [])
		.map((l, i) => (/previz/i.test(l.name ?? '') ? i : -1))
		.filter(i => i !== -1)
}

/** Preview filename of the previz image for a timeline frame, or null. */
function previzFilenameFor(frame: number): string | null {
	const p = project.value
	if (!p) return null
	for (const layer of previzLayerIndices(p)) {
		const f = refFilename(p.komas[frame]?.shots?.[layer]?.lv)
		if (f) return f
	}
	return null
}

/**
 * What screen A loops: first the film as it stands — every frame of the Main
 * layer, and where a frame hasn't been shot yet, the previz render for it —
 * then every other take (tests, replays, park references, and the discarded
 * ones in the trash) in the order they were shot.
 */
const frames = computed<ExhibitFrame[]>(() => {
	const p = project.value
	if (!p) return []
	const allowed = exhibitLayers(p)
	const previz = previzLayerIndices(p)
	const previzSet = new Set(previz)
	const out: ExhibitFrame[] = []
	const push = (
		shot: RawShot,
		frame: number,
		layer: number,
		take: ExhibitFrame['take'],
		dir = ''
	) => {
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
			filmLift: shot.filmLift ?? (shot.kBase === undefined ? undefined : 60 * shot.kBase),
			previzFrame: shot.previzFrame,
			led: shot.led?.file,
		})
	}

	// 1. The film: Main (layer 0), previz filling the gaps.
	p.komas.forEach((koma, frame) => {
		const main = koma?.shots?.[0]
		if (main) {
			push(main, frame, 0, 'main')
			return
		}
		for (const layer of previz) {
			const pv = koma?.shots?.[layer]
			if (pv) {
				push(pv, frame, layer, 'previz')
				return
			}
		}
	})

	// 2. Every other take, chronologically.
	const takes: {f: ExhibitFrame; i: number}[] = []
	const collect = (shot: RawShot, frame: number, layer: number, take: 'live' | 'trash', dir = '') => {
		const before = out.length
		push(shot, frame, layer, take, dir)
		if (out.length > before) takes.push({f: out.pop()!, i: takes.length})
	}
	p.komas.forEach((koma, frame) => {
		koma?.shots?.forEach((shot, layer) => {
			if (!shot || layer === 0 || previzSet.has(layer)) return
			if (allowed && !allowed.has(layer)) return
			collect(shot, frame, layer, 'live')
		})
	})
	for (const t of p.trash ?? []) {
		if (!t?.shot || previzSet.has(t.layer)) continue
		if (allowed && !allowed.has(t.layer)) continue
		collect(t.shot, t.frame, t.layer, 'trash', '_trash')
	}
	takes.sort((a, b) => {
		const da = a.f.captureDate ?? Infinity
		const db = b.f.captureDate ?? Infinity
		return da === db ? a.i - b.i : da - db
	})
	for (const {f} of takes) out.push(f)
	return out
})

/** Cheap identity of the take list, to know when the video must be rebuilt. */
const framesSignature = computed(() => {
	const fs = frames.value
	return `${fs.length}:${fs[0]?.filename ?? ''}:${fs[fs.length - 1]?.filename ?? ''}:${fs[fs.length - 1]?.captureDate ?? ''}`
})

const fps = computed(() => project.value?.fps ?? 18)

const shown = computed<ExhibitFrame | null>(() => frames.value[shownIndex.value] ?? null)

/** Take filename → index into `frames`, to follow screen A by identity. */
const indexByFilename = computed(() => {
	const m = new Map<string, number>()
	frames.value.forEach((f, i) => {
		if (!m.has(f.filename)) m.set(f.filename, i)
	})
	return m
})

/** What screen A last said it was showing (screen B resolves it by filename). */
export interface Playhead {
	index: number
	filename: string
}

const lastPlayhead = shallowRef<Playhead | null>(null)

/**
 * Follow screen A. The take is matched by filename — the two windows may
 * hold different versions of project.json (a take was just added, or A is
 * still playing the video it encoded from an older list), in which case the
 * bare index would point at the wrong take.
 */
function syncTo(head: Playhead) {
	lastPlayhead.value = head
	const i = indexByFilename.value.get(head.filename)
	shownIndex.value = i ?? Math.min(head.index, Math.max(0, frames.value.length - 1))
}

// The take list changed under us (project.json re-read): re-resolve.
watch(frames, () => {
	if (lastPlayhead.value) syncTo(lastPlayhead.value)
})

//------------------------------------------------------------------------------
// Source selection

function useSource(s: ProjectSource) {
	source.value = s
	permission.value = 'granted'
	project.value = null
	projectVersion.value = null
	previzFile.value = null
	previzVersion.value = null
	textCache.clear()
	startPolling()
}

/**
 * The relay to use, if any: `?relay=<http://host:port>`, else the page's own
 * origin when it is served by koma-relay (probed with /api/status).
 */
async function detectRelay(): Promise<string | null> {
	const params = new URLSearchParams(location.search)
	const explicit = params.get('relay')
	if (explicit) return explicit.replace(/\/+$/, '')
	if (location.protocol !== 'http:' && location.protocol !== 'https:') return null
	try {
		const res = await fetch('/api/status', {cache: 'no-store'})
		// A dev server answers any path with index.html (200): insist on the
		// relay's JSON shape.
		if (res.ok && /json/i.test(res.headers.get('content-type') ?? '')) {
			const body = await res.json()
			if (body && typeof body === 'object' && 'capture' in body) return location.origin
		}
	} catch {
		// not served by the relay
	}
	return null
}

/**
 * Dev / kiosk aid: `?opfs=<name>` reads the project from that folder in the
 * browser's own storage (OPFS) instead of a picked folder, and
 * `?seed=<url>` first copies `project.json` and every preview it references
 * from that URL into it. Lets a project be checked without a picker (e.g.
 * from a test runner, or served by a dev server).
 */
async function restoreFromQuery(): Promise<boolean> {
	const params = new URLSearchParams(location.search)
	const name = params.get('opfs')
	if (!name) return false
	const root = await navigator.storage.getDirectory()
	const h = await root.getDirectoryHandle(name, {create: true})
	const seed = params.get('seed')
	if (seed) {
		try {
			await seedFromUrl(h, seed)
		} catch (e) {
			error.value = `seed failed: ${e instanceof Error ? e.message : String(e)}`
		}
	}
	useSource(new DirSource(h))
	return true
}

async function seedFromUrl(h: FileSystemDirectoryHandle, base: string) {
	const url = (rel: string) => new URL(rel, new URL(base, location.href)).toString()
	const res = await fetch(url('project.json'), {cache: 'no-store'})
	if (!res.ok) throw new Error(`project.json ${res.status}`)
	const text = await res.text()
	const p = JSON.parse(text) as RawProject
	const files = new Set<string>()
	for (const koma of p.komas) {
		for (const shot of koma?.shots ?? []) {
			const f = refFilename(shot?.lv)
			if (f) files.add(f)
		}
	}
	for (const t of p.trash ?? []) {
		const f = refFilename(t?.shot?.lv)
		if (f) files.add(`_trash/${f}`)
	}
	await writeInto(h, 'project.json', new Blob([text]))
	// previz/frames.json and the G-code it references (for the G-CODE pane).
	try {
		const pr = await fetch(url(PREVIZ_FRAMES), {cache: 'no-store'})
		if (pr.ok) {
			const ptext = await pr.text()
			await writeInto(h, PREVIZ_FRAMES, new Blob([ptext]))
			const pf = JSON.parse(ptext) as PrevizFile
			const pattern = pf.paths?.gcode ?? 'gcode/%04d.nc'
			for (const fr of pf.frames) {
				if (fr.cut === false) continue
				const rel =
					fr.gcode ??
					pattern.replace(/%0?(\d*)d/, (_, w) => String(fr.frame).padStart(Number(w || 0), '0'))
				files.add(`previz/${rel}`)
			}
		}
	} catch {
		// no previz — fine
	}
	const layerGcode = (p.addsub as any)?.layerGcode as Record<string, string> | undefined
	if (layerGcode && p.layers) {
		p.komas.forEach((koma, frame) => {
			koma?.shots?.forEach((shot, layer) => {
				const id = p.layers?.[layer]?.id
				if (shot && id && layerGcode[id]) files.add(expand(layerGcode[id], frame))
			})
		})
	}
	let n = 0
	const list = [...files]
	const CONCURRENCY = 8
	await Promise.all(
		Array.from({length: CONCURRENCY}, async () => {
			for (;;) {
				const rel = list.shift()
				if (!rel) return
				// Skip files already present (re-runs are cheap).
				if (await exists(h, rel)) continue
				const r = await fetch(url(rel), {cache: 'no-store'})
				if (!r.ok) continue
				await writeInto(h, rel, await r.blob())
				n++
			}
		})
	)
	// eslint-disable-next-line no-console
	console.info(`[exhibit] seeded ${n} files into OPFS/${h.name}`)
}

async function exists(root: FileSystemDirectoryHandle, rel: string) {
	try {
		await getFileHandle(root, rel)
		return true
	} catch {
		return false
	}
}

async function writeInto(root: FileSystemDirectoryHandle, rel: string, blob: Blob) {
	const parts = rel.split('/').filter(Boolean)
	let d = root
	for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part, {create: true})
	const fh = await d.getFileHandle(parts[parts.length - 1], {create: true})
	const w = await fh.createWritable()
	await w.write(blob)
	await w.close()
}

async function getFileHandle(root: FileSystemDirectoryHandle, rel: string) {
	const parts = rel.split('/').filter(Boolean)
	let d = root
	for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part)
	return d.getFileHandle(parts[parts.length - 1])
}

type SourcePref = 'dir' | 'relay'

function sourcePref(): SourcePref | null {
	try {
		const v = localStorage.getItem(SOURCE_PREF_KEY)
		return v === 'dir' || v === 'relay' ? v : null
	} catch {
		return null
	}
}

function setSourcePref(v: SourcePref | null) {
	try {
		if (v) localStorage.setItem(SOURCE_PREF_KEY, v)
		else localStorage.removeItem(SOURCE_PREF_KEY)
	} catch {
		// private mode etc.
	}
}

/** The relay found at startup (its live state is used with either source). */
const relayBase = ref<string | null>(null)

async function rememberedHandle(): Promise<FileSystemDirectoryHandle | null> {
	try {
		return ((await get(HANDLE_KEY)) as FileSystemDirectoryHandle | undefined) ?? null
	} catch (e) {
		error.value = e instanceof Error ? e.message : String(e)
		return null
	}
}

/** Use a remembered folder handle; polls at once when it is still readable. */
async function useRememberedDir(h: FileSystemDirectoryHandle) {
	source.value = new DirSource(h)
	project.value = null
	projectVersion.value = null
	previzFile.value = null
	previzVersion.value = null
	textCache.clear()
	try {
		permission.value = await h.queryPermission({mode: 'read'})
	} catch (e) {
		// A handle from another profile / a removed volume.
		permission.value = 'denied'
		error.value = e instanceof Error ? e.message : String(e)
		return
	}
	if (permission.value === 'granted') startPolling()
	else armGesturePermission()
}

/**
 * Pick the source at startup. A relay, when reachable, always supplies the
 * live state; the project comes from the folder the user picked last if
 * they did, else from the relay, else from `?opfs=`, else from a
 * remembered folder.
 */
async function restore() {
	// Ask the browser not to evict our storage (the folder handle in
	// IndexedDB, the encoded loop in OPFS) under pressure.
	void navigator.storage?.persist?.().catch(() => false)

	const base = await detectRelay()
	relayBase.value = base
	if (base) relay.connect(base)

	const pref = sourcePref()
	if (pref === 'dir') {
		const h = await rememberedHandle()
		if (h) {
			await useRememberedDir(h)
			return
		}
	}
	if (base) {
		useSource(new HttpSource(`${base}/project/`))
		return
	}
	if (await restoreFromQuery().catch(() => false)) return
	const h = await rememberedHandle()
	if (h) await useRememberedDir(h)
}

// A pushed project.json / frames.json: don't wait for the poll.
relay.onFile(({rel}) => {
	if (rel === 'project.json' || rel === PREVIZ_FRAMES) void poll()
})

/** Needs a user gesture. */
async function requestPermission() {
	const s = source.value
	if (!(s instanceof DirSource)) return
	try {
		permission.value = await s.handle.requestPermission({mode: 'read'})
	} catch {
		return
	}
	if (permission.value === 'granted') startPolling()
}

/**
 * After a browser restart Chrome needs one gesture before a remembered
 * folder can be read again (unless "Allow on every visit" was chosen). Any
 * click or key on the page is enough — hook the first one so the person
 * doesn't have to find the button.
 */
let gestureArmed = false
function armGesturePermission() {
	if (gestureArmed || typeof window === 'undefined') return
	gestureArmed = true
	const onGesture = () => {
		if (permission.value === 'granted' || !(source.value instanceof DirSource)) {
			disarm()
			return
		}
		void requestPermission().then(() => {
			if (permission.value === 'granted') disarm()
		})
	}
	const disarm = () => {
		gestureArmed = false
		window.removeEventListener('pointerdown', onGesture)
		window.removeEventListener('keydown', onGesture)
	}
	window.addEventListener('pointerdown', onGesture)
	window.addEventListener('keydown', onGesture)
}

/** Needs a user gesture. */
async function pick() {
	try {
		const h = await window.showDirectoryPicker({id: 'exhibit', mode: 'read'})
		await set(HANDLE_KEY, h)
		setSourcePref('dir')
		useSource(new DirSource(h))
	} catch {
		// cancelled
	}
}

/** Read the project from the relay again (the folder stays remembered). */
function useRelay() {
	const base = relayBase.value
	if (!base) return
	setSourcePref('relay')
	useSource(new HttpSource(`${base}/project/`))
}

async function forget() {
	stopPolling()
	await del(HANDLE_KEY)
	setSourcePref(null)
	source.value = null
	project.value = null
	permission.value = 'none'
	if (relayBase.value) useSource(new HttpSource(`${relayBase.value}/project/`))
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

async function pollPreviz(s: ProjectSource) {
	try {
		const r = await s.text(PREVIZ_FRAMES, previzVersion.value)
		if (r === 'unchanged') return
		if (r === null) throw new Error('missing')
		previzFile.value = JSON.parse(r.text) as PrevizFile
		previzVersion.value = r.version
		previzModified.value = Date.now()
		textCache.clear()
	} catch {
		if (previzFile.value) {
			previzFile.value = null
			previzVersion.value = null
			previzModified.value = Date.now()
		}
	}
}

function expand(pattern: string, n: number) {
	return pattern.replace(/%0?(\d*)d/, (_, w) => String(n).padStart(Number(w || 0), '0'))
}

/**
 * Path (relative to the project folder) of the G-code behind a shown frame:
 * a take on another layer uses that layer's own files (addsub.layerGcode),
 * the film (and its previz stand-ins) the cut planned in previz/frames.json.
 */
function gcodePathFor(timelineFrame: number, layer = 0): string | null {
	const p = project.value
	const layerGcode = (p?.addsub as any)?.layerGcode as Record<string, string> | undefined
	const layerId = p?.layers?.[layer]?.id
	if (layer !== 0 && layerId && layerGcode?.[layerId]) {
		return expand(layerGcode[layerId], timelineFrame)
	}
	const pf = previzFile.value
	if (!pf) return null
	const offset = (project.value?.addsub as any)?.previzFrameOffset ?? 0
	const n = timelineFrame + offset
	const entry = pf.frames.find(f => f.frame === n)
	if (!entry || entry.cut === false) return null
	const pattern = pf.paths?.gcode ?? 'gcode/%04d.nc'
	return `previz/${entry.gcode ?? expand(pattern, n)}`
}

function readText(rel: string): Promise<string | null> {
	let p = textCache.get(rel)
	if (p) {
		// Refresh LRU order.
		textCache.delete(rel)
		textCache.set(rel, p)
	} else {
		p = (async () => {
			const s = source.value
			if (!s) return null
			try {
				const r = await s.text(rel)
				return r && r !== 'unchanged' ? r.text : null
			} catch {
				return null
			}
		})()
		textCache.set(rel, p)
		while (textCache.size > TEXT_CACHE_LIMIT) {
			const oldest = textCache.keys().next().value as string
			textCache.delete(oldest)
		}
	}
	return p
}

async function poll() {
	const s = source.value
	if (!s || state.polling) return
	state.polling = true
	try {
		await pollPreviz(s)
		for (let attempt = 0; attempt < 4; attempt++) {
			try {
				const r = await s.text('project.json', attempt === 0 ? projectVersion.value : null)
				if (r === 'unchanged') return
				if (r === null) {
					error.value = 'project.json not found'
					return
				}
				project.value = JSON.parse(r.text) as RawProject
				projectVersion.value = r.version
				error.value = null
				return
			} catch (e) {
				// Probably mid-write — wait a moment and read again.
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
		try {
			const blob = await frameBlob(filename)
			if (!blob) return null
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

/** Read a take's preview bytes (not cached as a URL). */
async function frameBlob(filename: string): Promise<Blob | null> {
	const s = source.value
	if (!s) return null
	try {
		return await s.blob(filename)
	} catch {
		return null
	}
}

export function useExhibitStore() {
	return {
		source: readonly(source),
		permission: readonly(permission),
		project: readonly(project),
		frames,
		framesSignature,
		fps,
		shownIndex,
		shown,
		indexByFilename,
		syncTo,
		relayBase: readonly(relayBase),
		error: readonly(error),
		restore,
		requestPermission,
		pick,
		useRelay,
		forget,
		frameUrl,
		frameBlob,
		previzFilenameFor,
		gcodePathFor,
		readText,
		previzModified: readonly(previzModified),
	}
}
