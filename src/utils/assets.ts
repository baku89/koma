// Runtime asset store.
//
// Project state (komas[].shots[].{lv,jpg,raw}) no longer holds Blobs — it holds
// a session-only string id per image. The actual bytes live on disk in the
// project directory and are resolved here lazily (getFile → object URL) on
// first display. This replaces the old OPFS hard-copy that read+rewrote every
// referenced file into an immutable cache on open (slow first open, double
// storage). The decoupling that copy provided — in-memory references that
// survive the directory file being renamed/overwritten — is instead achieved by
// never holding a path-bound Blob in reactive state: the id is stable, the bytes
// are fetched fresh (or served from a cached object URL, which is detached from
// disk once created).
//
// On save, `reconcileAssets()` makes the on-disk paths match the timeline:
// live frames are renamed (byte-free `move()`) to their sequential paths, and
// files no longer referenced are moved into a `_trash/` subfolder (kept in the
// project, restored automatically on undo) rather than deleted.
//
// Paths are `/`-separated and relative to a root: the project folder for live
// frames (`Main/0001.jpg`, or the flat `name_layer=0_0001.jpg` of older
// projects — see utils/projectLayout.ts), `_trash` for displaced ones
// (`Main/<id>__0001.jpg`). Intermediate folders are created on the way in and
// removed when a move leaves them empty.

interface AssetEntry {
	/** Current on-disk path (`/`-separated) relative to `parentDir`. */
	filename: string
	/** Root the path is relative to (project dir, or `_trash`). Undefined until
	 *  the bytes have been written somewhere. */
	parentDir?: FileSystemDirectoryHandle
	/** Cached handle for `filename` under `parentDir`. */
	handle?: FileSystemFileHandle
	/** In-memory bytes (freshly captured this session; kept so a re-shoot that
	 *  overwrites the on-disk file can't corrupt an undo-reachable id). */
	blob?: Blob
	/** Cached object URL; once created it is detached from disk. */
	url?: string
	/** True while the file lives under `_trash/` (deleted but recoverable). */
	trashed?: boolean
}

export const TRASH_DIR = '_trash'

const entries = new Map<string, AssetEntry>()

// LRU bound on how many resolved object URLs (and their detached in-memory
// bytes) we keep alive at once. The timeline is virtualized, so the live set is
// roughly the visible thumbnails; this caps memory while keeping re-scroll fast.
const URL_CACHE_CAP = 500
const urlOrder = new Set<string>()

function touchUrl(id: string) {
	urlOrder.delete(id)
	urlOrder.add(id)
	while (urlOrder.size > URL_CACHE_CAP) {
		const oldest = urlOrder.values().next().value as string
		urlOrder.delete(oldest)
		const e = entries.get(oldest)
		if (e?.url) {
			URL.revokeObjectURL(e.url)
			e.url = undefined
		}
	}
}

function newId(): string {
	return crypto.randomUUID()
}

async function sameDir(
	a: FileSystemDirectoryHandle | undefined,
	b: FileSystemDirectoryHandle
): Promise<boolean> {
	if (!a) return false
	if (a === b) return true
	return a.isSameEntry(b)
}

//------------------------------------------------------------------------------
// Paths

export function dirnameOf(path: string): string {
	const i = path.lastIndexOf('/')
	return i === -1 ? '' : path.slice(0, i)
}

export function basenameOf(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * The directory handle for `path`'s folder under `root` (created on the way
 * with `create`), and the file's own name.
 */
export async function walkPath(
	root: FileSystemDirectoryHandle,
	path: string,
	create: boolean
): Promise<{dir: FileSystemDirectoryHandle; name: string}> {
	const parts = path.split('/').filter(Boolean)
	let dir = root
	for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, {create})
	return {dir, name: parts[parts.length - 1]}
}

async function isEmptyDir(dir: FileSystemDirectoryHandle): Promise<boolean> {
	for await (const _ of dir.keys()) return false
	return true
}

/**
 * Remove the folder at `path` under `root` if it holds nothing (a layer folder
 * — or `_trash/<layer>` — whose last file just moved out). A folder that still
 * has anything in it, even a `.DS_Store`, stays. Never the root itself.
 */
export async function removeDirIfEmpty(root: FileSystemDirectoryHandle, path: string): Promise<boolean> {
	const parts = path.split('/').filter(Boolean)
	if (parts.length === 0) return false
	try {
		const {dir: parent, name} = await walkPath(root, path, false)
		const dir = await parent.getDirectoryHandle(name)
		if (!(await isEmptyDir(dir))) return false
		await parent.removeEntry(name)
		return true
	} catch {
		return false
	}
}

//------------------------------------------------------------------------------
// Registering

/** Revoke every cached object URL and drop all entries (on open / new project). */
export function clearAssets() {
	for (const e of entries.values()) {
		if (e.url) URL.revokeObjectURL(e.url)
	}
	entries.clear()
	urlOrder.clear()
}

/** Register an asset that already exists on disk (project load). Lazy: no read. */
export function registerDiskAsset(
	filename: string,
	dir: FileSystemDirectoryHandle
): string {
	const id = newId()
	entries.set(id, {filename, parentDir: dir})
	return id
}

/** Register a freshly captured asset (bytes in memory, not yet written). */
export function registerCapturedAsset(blob: Blob, filename: string): string {
	const id = newId()
	entries.set(id, {filename, blob})
	return id
}

/** Register an asset that already lives in the project's `_trash/` folder — a
 *  displaced shot reloaded from disk. Lazy: no bytes are read. */
export function registerTrashedAsset(
	filename: string,
	trashDir: FileSystemDirectoryHandle
): string {
	const id = newId()
	entries.set(id, {filename, parentDir: trashDir, trashed: true})
	return id
}

export function getAssetFilename(id: string): string | undefined {
	return entries.get(id)?.filename
}

export function setAssetFilename(id: string, filename: string) {
	const e = entries.get(id)
	if (e) e.filename = filename
}

export function isAssetTrashed(id: string): boolean {
	return !!entries.get(id)?.trashed
}

/**
 * Paths (relative to the project folder) of every asset currently on disk
 * there — what a folder sweep must leave alone because reconcile owns it.
 */
export function liveAssetPaths(): Set<string> {
	const out = new Set<string>()
	for (const e of entries.values()) {
		if (e.parentDir && !e.trashed) out.add(e.filename)
	}
	return out
}

/**
 * Replace a disk-backed asset's bytes with an in-memory blob, keeping its id and
 * filename. Used to self-heal a live-view preview whose on-disk file is gone:
 * regenerate it from the hi-res jpg, stash it here so it resolves immediately,
 * and drop the disk pointer so the next reconcile *writes* these bytes out under
 * the (unchanged) filename instead of skipping it as already-in-place.
 */
export function healAssetBlob(id: string, blob: Blob) {
	const e = entries.get(id)
	if (!e) return
	if (e.url) {
		URL.revokeObjectURL(e.url)
		urlOrder.delete(id)
		e.url = undefined
	}
	e.blob = blob
	e.parentDir = undefined
	e.handle = undefined
}

//------------------------------------------------------------------------------
// Resolving

async function getHandle(e: AssetEntry): Promise<FileSystemFileHandle | undefined> {
	if (e.handle) return e.handle
	if (!e.parentDir) return undefined
	try {
		const {dir, name} = await walkPath(e.parentDir, e.filename, false)
		e.handle = await dir.getFileHandle(name)
	} catch {
		// File (or its folder) missing.
	}
	return e.handle
}

async function getBlob(e: AssetEntry): Promise<Blob | undefined> {
	if (e.blob) return e.blob
	try {
		const handle = await getHandle(e)
		if (handle) return await handle.getFile()
	} catch {
		// File missing or its snapshot was invalidated by an external change.
	}
	return undefined
}

export async function resolveBlob(
	id: string | undefined
): Promise<Blob | undefined> {
	if (!id) return undefined
	const e = entries.get(id)
	if (!e) return undefined
	return getBlob(e)
}

export async function resolveAssetUrl(
	id: string | undefined
): Promise<string | undefined> {
	if (!id) return undefined
	const e = entries.get(id)
	if (!e) return undefined
	if (e.url) {
		touchUrl(id)
		return e.url
	}
	const blob = await getBlob(e)
	if (!blob) return undefined
	// Detach from disk before making the URL. An object URL backed by a
	// FileSystemFileHandle's File breaks the moment the underlying file is
	// renamed/moved (which reconcile does on every edit, and trashing does on
	// delete). Copying the bytes into memory makes the URL survive those moves —
	// the content never changes, so the snapshot stays correct. (Captured assets
	// already hold an in-memory blob, so no copy is needed.)
	const detached = e.blob ?? new Blob([await blob.arrayBuffer()], {type: blob.type})
	e.url = URL.createObjectURL(detached)
	touchUrl(id)
	return e.url
}

//------------------------------------------------------------------------------
// Moving

/** Folders (relative to their root) a move just took a file out of. */
type Vacated = {root: FileSystemDirectoryHandle; dir: string}[]

/**
 * Ensure the entry's bytes end up at `toPath` under `toRoot`, wherever they
 * currently are: rename within a folder, move across folders (both byte-free
 * via move()), or write from memory. Falls back to copy+delete if move() is
 * unavailable (Chrome: handles from showDirectoryPicker).
 */
async function moveEntry(
	e: AssetEntry,
	toRoot: FileSystemDirectoryHandle,
	toPath: string,
	trashed: boolean,
	vacated?: Vacated
) {
	// A loaded-but-never-resolved asset has no handle yet; acquire it so we can
	// move the file instead of re-reading and rewriting it.
	const handle = await getHandle(e)
	const fromRoot = e.parentDir
	const fromPath = e.filename

	if (handle && fromRoot) {
		const from = await walkPath(fromRoot, fromPath, false).catch(() => undefined)
		const {dir: toDir, name: toName} = await walkPath(toRoot, toPath, true)
		try {
			if (from && (await sameDir(from.dir, toDir))) {
				await (handle as any).move(toName)
			} else {
				await (handle as any).move(toDir, toName)
			}
			e.handle = await toDir.getFileHandle(toName)
		} catch {
			await copyDelete(e, from?.dir, toDir, toName)
		}
	} else if (e.blob) {
		const {dir: toDir, name: toName} = await walkPath(toRoot, toPath, true)
		const h = await toDir.getFileHandle(toName, {create: true})
		const writable = await h.createWritable()
		await writable.write(e.blob)
		await writable.close()
		e.handle = h
	} else {
		return // no bytes anywhere — nothing to persist
	}

	if (fromRoot && vacated) {
		const dir = dirnameOf(fromPath)
		if (dir && !(fromRoot === toRoot && dir === dirnameOf(toPath))) vacated.push({root: fromRoot, dir})
	}
	e.parentDir = toRoot
	e.filename = toPath
	e.trashed = trashed
}

async function copyDelete(
	e: AssetEntry,
	oldDir: FileSystemDirectoryHandle | undefined,
	toDir: FileSystemDirectoryHandle,
	toName: string
) {
	const blob = await getBlob(e)
	if (!blob) return
	const oldName = e.handle?.name ?? basenameOf(e.filename)
	const handle = await toDir.getFileHandle(toName, {create: true})
	const writable = await handle.createWritable()
	await writable.write(blob)
	await writable.close()
	e.handle = handle
	// Remove the source unless it is literally the file we just wrote. This must
	// also fire for same-directory renames (the `_tmp_*` two-phase case) — not
	// doing so was what left orphaned `_tmp_#` and stale-named files behind.
	const samePath = (await sameDir(oldDir, toDir)) && oldName === toName
	if (oldDir && !samePath) {
		try {
			await oldDir.removeEntry(oldName)
		} catch {
			// ignore
		}
	}
}

/** Where a displaced file goes under `_trash`: same folder, id-prefixed name. */
function trashPath(id: string, path: string): string {
	const dir = dirnameOf(path)
	return `${dir ? `${dir}/` : ''}${id}__${basenameOf(path)}`
}

async function removeVacated(vacated: Vacated) {
	const seen = new Set<string>()
	for (const {root, dir} of vacated) {
		// Deepest first, so `_trash/Main` goes before `Main` would (if nested).
		const parts = dir.split('/').filter(Boolean)
		for (let n = parts.length; n > 0; n--) {
			const path = parts.slice(0, n).join('/')
			const key = `${root.name}\u0000${path}`
			if (seen.has(key)) break
			seen.add(key)
			if (!(await removeDirIfEmpty(root, path))) break
		}
	}
}

/**
 * Move trashed assets around inside `_trash` (migration / a layer folder
 * rename): `map` gets each trashed asset's current path and returns the new
 * one, or undefined to leave it.
 */
export async function relocateTrashedAssets(
	map: (id: string, path: string) => string | undefined
): Promise<number> {
	const vacated: Vacated = []
	let moved = 0
	for (const [id, e] of entries) {
		if (!e.trashed || !e.parentDir) continue
		const to = map(id, e.filename)
		if (to === undefined || to === e.filename) continue
		await moveEntry(e, e.parentDir, to, true, vacated)
		moved++
	}
	await removeVacated(vacated)
	return moved
}

/**
 * Make the project folder reflect the current timeline.
 *
 * @param dir          project directory
 * @param desired      live frame assets and the sequential path each should have
 * @param protectedIds every id still referenced by the project (won't be trashed)
 * @param trashedIds   ids referenced only by the project's trash ledger; their
 *                     bytes must end up in `_trash` even if they were captured
 *                     this session and never written to a live slot
 */
export async function reconcileAssets(
	dir: FileSystemDirectoryHandle,
	desired: {id: string; name: string}[],
	protectedIds: Set<string>,
	trashedIds: string[] = []
) {
	// Created lazily — only when there is actually something to trash.
	let trashDir: FileSystemDirectoryHandle | undefined
	const getTrashDir = async () =>
		(trashDir ??= await dir.getDirectoryHandle(TRASH_DIR, {create: true}))
	const vacated: Vacated = []

	// 1. Move files that live in the project folder but are no longer referenced
	//    into _trash (kept, not deleted — undo can bring them back).
	for (const [id, e] of entries) {
		if (e.trashed || !e.parentDir) continue
		if (protectedIds.has(id)) continue
		if (!(await sameDir(e.parentDir, dir))) continue
		await moveEntry(e, await getTrashDir(), trashPath(id, e.filename), true, vacated)
	}

	// 1b. Persist trashed shots whose bytes only exist in memory (captured this
	//     session and displaced before any save wrote them to a live slot). Disk-
	//     backed displaced shots were already moved to _trash by step 1.
	for (const id of trashedIds) {
		const e = entries.get(id)
		if (!e || e.trashed || !e.blob) continue
		await moveEntry(e, await getTrashDir(), trashPath(id, e.filename), true, vacated)
	}

	// 2. Rename live assets to their sequential paths.
	const dirty: {e: AssetEntry; name: string}[] = []
	for (const {id, name} of desired) {
		const e = entries.get(id)
		if (!e) continue
		const inDir = !e.trashed && (await sameDir(e.parentDir, dir))
		if (inDir && e.filename === name) continue
		dirty.push({e, name})
	}

	// Rename one at a time, always picking an asset whose target path is currently
	// free, so a shift cascades cleanly (…→0002, …→0003) with no temp files. Only
	// a genuine cycle (rare) needs to park one file on a temp. This avoids staging
	// *every* file through a temp at once (the old two-phase pass), which on a local
	// folder — where move() falls back to copy+delete — meant a swarm of `_tmp_#`
	// swap files and two byte-copies per file.
	const remaining = dirty.map(d => ({e: d.e, target: d.name, from: d.e.filename}))
	const occupied = new Set(remaining.map(p => p.from))
	let tempCounter = 0

	while (remaining.length > 0) {
		const idx = remaining.findIndex(p => !occupied.has(p.target))
		if (idx >= 0) {
			const [p] = remaining.splice(idx, 1)
			occupied.delete(p.from)
			await moveEntry(p.e, dir, p.target, false, vacated)
		} else {
			// Every remaining target is still occupied → a cycle; park one on a temp
			// to free its name, then it'll land on its target once that frees up.
			const p = remaining.shift()!
			const tmp = `_tmp_${tempCounter++}`
			occupied.delete(p.from)
			await moveEntry(p.e, dir, tmp, false, vacated)
			occupied.add(tmp)
			remaining.push({e: p.e, target: p.target, from: tmp})
		}
	}

	// 3. Sweep stray temp files. After a successful run none of our own temps
	//    remain; anything left is litter from an interrupted or pre-fix run.
	for await (const name of dir.keys()) {
		if (name.startsWith('_tmp_')) {
			try {
				await dir.removeEntry(name)
			} catch {
				// ignore
			}
		}
	}

	// 4. Folders the moves emptied (a renamed layer's old folder, `_trash/<old>`).
	await removeVacated(vacated)
}
