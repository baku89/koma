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
// On save, `reconcileAssets()` makes the on-disk filenames match the timeline:
// live frames are renamed (byte-free `move()`) to their sequential names, and
// files no longer referenced are moved into a `_trash/` subfolder (kept in the
// project, restored automatically on undo) rather than deleted.

interface AssetEntry {
	/** Current on-disk filename within `parentDir`. */
	filename: string
	/** Directory the on-disk copy currently lives in (project dir, or `_trash`).
	 *  Undefined until the bytes have been written somewhere. */
	parentDir?: FileSystemDirectoryHandle
	/** Cached handle for `filename` in `parentDir`. */
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

async function getBlob(e: AssetEntry): Promise<Blob | undefined> {
	if (e.blob) return e.blob
	try {
		if (!e.handle && e.parentDir) {
			e.handle = await e.parentDir.getFileHandle(e.filename)
		}
		if (e.handle) return await e.handle.getFile()
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

/**
 * Ensure the entry's bytes end up at (toDir, toName), wherever they currently
 * are: rename within a folder, move across folders (both byte-free via move()),
 * or write from memory. Falls back to copy+delete if move() is unavailable.
 */
async function moveEntry(
	e: AssetEntry,
	toDir: FileSystemDirectoryHandle,
	toName: string,
	trashed: boolean
) {
	// A loaded-but-never-resolved asset has no handle yet; acquire it so we can
	// move the file instead of re-reading and rewriting it.
	if (!e.handle && !e.blob && e.parentDir) {
		try {
			e.handle = await e.parentDir.getFileHandle(e.filename)
		} catch {
			// fall through; nothing to move
		}
	}

	if (e.handle && e.parentDir) {
		try {
			if (await sameDir(e.parentDir, toDir)) {
				await (e.handle as any).move(toName)
			} else {
				await (e.handle as any).move(toDir, toName)
			}
			e.handle = await toDir.getFileHandle(toName)
		} catch {
			await copyDelete(e, toDir, toName)
		}
	} else if (e.blob) {
		const handle = await toDir.getFileHandle(toName, {create: true})
		const writable = await handle.createWritable()
		await writable.write(e.blob)
		await writable.close()
		e.handle = handle
	} else {
		return // no bytes anywhere — nothing to persist
	}

	e.parentDir = toDir
	e.filename = toName
	e.trashed = trashed
}

async function copyDelete(
	e: AssetEntry,
	toDir: FileSystemDirectoryHandle,
	toName: string
) {
	const blob = await getBlob(e)
	if (!blob) return
	const oldDir = e.parentDir
	const oldName = e.handle?.name ?? e.filename
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

function trashName(id: string, filename: string): string {
	return `${id}__${filename}`
}

/**
 * Make the project folder reflect the current timeline.
 *
 * @param dir          project directory
 * @param desired      live frame assets and the sequential name each should have
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

	// 1. Move files that live in the project folder but are no longer referenced
	//    into _trash (kept, not deleted — undo can bring them back).
	for (const [id, e] of entries) {
		if (e.trashed || !e.parentDir) continue
		if (protectedIds.has(id)) continue
		if (!(await sameDir(e.parentDir, dir))) continue
		await moveEntry(e, await getTrashDir(), trashName(id, e.filename), true)
	}

	// 1b. Persist trashed shots whose bytes only exist in memory (captured this
	//     session and displaced before any save wrote them to a live slot). Disk-
	//     backed displaced shots were already moved to _trash by step 1.
	for (const id of trashedIds) {
		const e = entries.get(id)
		if (!e || e.trashed || !e.blob) continue
		await moveEntry(e, await getTrashDir(), trashName(id, e.filename), true)
	}

	// 2. Rename live assets to their sequential names. Two-phase through unique
	//    temp names so a cascade of renames (e.g. deleting a middle frame) never
	//    clobbers a file that another asset still needs.
	const dirty: {e: AssetEntry; name: string}[] = []
	for (const {id, name} of desired) {
		const e = entries.get(id)
		if (!e) continue
		const inDir = !e.trashed && (await sameDir(e.parentDir, dir))
		if (inDir && e.filename === name) continue
		dirty.push({e, name})
	}

	// Rename one at a time, always picking an asset whose target name is currently
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
			await moveEntry(p.e, dir, p.target, false)
		} else {
			// Every remaining target is still occupied → a cycle; park one on a temp
			// to free its name, then it'll land on its target once that frees up.
			const p = remaining.shift()!
			const tmp = `_tmp_${tempCounter++}`
			occupied.delete(p.from)
			await moveEntry(p.e, dir, tmp, false)
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
}

/** Sequential, human-readable on-disk name for a frame asset. */
export function frameAssetFilename(
	name: string,
	layer: number,
	frame: number,
	type: 'lv' | 'jpg' | 'raw'
): string {
	const seq = frame.toString().padStart(4, '0')
	const ext = type === 'raw' ? 'dng' : 'jpg'
	// Frame number first, with live-view as a `.lv` sub-extension, so files sort
	// stably by frame: …_0001.jpg, …_0001.lv.jpg, …_0002.jpg (the old `_lv_####`
	// grouped all live-view files apart from their frames). Backward compatible:
	// existing projects keep their stored filenames until the next save, when the
	// reconcile pass renames them to this scheme.
	const sub = type === 'lv' ? '.lv' : ''
	return `${name}_layer=${layer}_${seq}${sub}.${ext}`
}
