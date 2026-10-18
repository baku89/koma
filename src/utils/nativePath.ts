/**
 * Where a FileSystemDirectoryHandle really is on disk — known only in the
 * desktop build (the main process sees the path of every folder the page is
 * granted; see electron/devices.ts), and only for folders picked from disk.
 * OPFS folders and the browser never have one, and every caller falls back
 * to the File System Access API then.
 */
import {native} from '@/electron'

const dirPaths = new WeakMap<FileSystemDirectoryHandle, string>()

export function registerNativeDirPath(handle: FileSystemDirectoryHandle, path: string) {
	dirPaths.set(handle, path)
}

/** `child` is the folder named `name` inside `parent`. */
export function registerNativeChildDir(
	parent: FileSystemDirectoryHandle,
	child: FileSystemDirectoryHandle,
	name: string
) {
	const p = dirPaths.get(parent)
	if (p) dirPaths.set(child, `${p}/${name}`)
}

export function nativeDirPath(handle: FileSystemDirectoryHandle | null | undefined): string | undefined {
	return handle ? dirPaths.get(handle) : undefined
}

/** Absolute path of `rel` (a `/`-separated path) under `root`, if known. */
export function nativeFilePath(
	root: FileSystemDirectoryHandle | null | undefined,
	rel: string
): string | undefined {
	const p = nativeDirPath(root)
	return p ? `${p}/${rel.replace(/^\/+/, '')}` : undefined
}

/**
 * Learn the real path of a just-granted directory (after the picker or a
 * permission request) from the main process. No-op outside Electron.
 */
export async function adoptNativeDirPath(
	handle: FileSystemDirectoryHandle
): Promise<string | undefined> {
	if (!native) return undefined
	const known = dirPaths.get(handle)
	if (known) return known
	const p = await native.grantedDirectoryPath(handle.name).catch(() => null)
	if (p) dirPaths.set(handle, p)
	return p ?? undefined
}

/**
 * Move a file byte-free through the main process when both ends have a known
 * path. Returns false (having done nothing) when they don't, so the caller
 * takes the File System Access route.
 */
export async function nativeRename(
	fromRoot: FileSystemDirectoryHandle | null | undefined,
	fromRel: string,
	toRoot: FileSystemDirectoryHandle | null | undefined,
	toRel: string
): Promise<boolean> {
	if (!native) return false
	const from = nativeFilePath(fromRoot, fromRel)
	const to = nativeFilePath(toRoot, toRel)
	if (!from || !to) return false
	await native.rename(from, to)
	return true
}
