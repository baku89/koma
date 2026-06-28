import {debounce} from 'lodash-es'
import {defineStore} from 'pinia'
import {ref} from 'vue'

import {
	getFileIfExists,
	hashFile,
	queryPermission,
	writeFileWithStream,
} from '@/utils'

export const useOpfsStore = defineStore('opfs', () => {
	let resolveLocalDirectoryHandle: (
		value: FileSystemDirectoryHandle
	) => void = () => null
	let resolveTempDirectoryHandle: (
		value: FileSystemDirectoryHandle
	) => void = () => null

	const localDirectoryHandle: Promise<FileSystemDirectoryHandle> = new Promise(
		resolve => {
			resolveLocalDirectoryHandle = resolve
		}
	)
	const tempDirectoryHandle: Promise<FileSystemDirectoryHandle> = new Promise(
		resolve => {
			resolveTempDirectoryHandle = resolve
		}
	)

	// StorageManager API
	const usage = ref(0)
	const quota = ref(0)

	const estimateStorage = debounce(async () => {
		const estimated = await navigator.storage.estimate()

		quota.value = estimated.quota ?? 0
		usage.value = estimated.usage ?? 0
	}, 1000)

	// Initialize the OPFS
	;(async () => {
		const root = await navigator.storage.getDirectory()

		const local = await root.getDirectoryHandle('local', {create: true})

		// `local/` is now a *container* of project subdirectories (local/<name>/).
		// Older builds kept a single project's files directly in local/; migrate it
		// into its own subdirectory once, before anyone reads the container.
		await migrateLegacyProject(local)

		resolveLocalDirectoryHandle(local)

		const tempDirectoryHandle = await root.getDirectoryHandle('__temp', {
			create: true,
		})

		resolveTempDirectoryHandle(tempDirectoryHandle)

		estimateStorage()
	})()

	// ---- Multi-project container helpers --------------------------------------

	/** Subdirectories of `local/`, one per in-app project. */
	async function listProjectDirs(): Promise<FileSystemDirectoryHandle[]> {
		const local = await localDirectoryHandle
		const dirs: FileSystemDirectoryHandle[] = []
		for await (const entry of local.values()) {
			if (entry.kind === 'directory') {
				dirs.push(entry as FileSystemDirectoryHandle)
			}
		}
		return dirs
	}

	/** Create (or get) an in-app project directory `local/<name>/`. */
	async function createProjectDir(
		name: string
	): Promise<FileSystemDirectoryHandle> {
		const local = await localDirectoryHandle
		return local.getDirectoryHandle(name, {create: true})
	}

	/** Whether `handle` is the `local/` container itself. */
	async function isLocalContainer(
		handle: FileSystemDirectoryHandle
	): Promise<boolean> {
		const local = await localDirectoryHandle
		return local.isSameEntry(handle)
	}

	/** Delete an in-app project directory and everything in it. */
	async function deleteProjectDir(name: string) {
		const local = await localDirectoryHandle
		await local.removeEntry(name, {recursive: true})
		estimateStorage()
	}

	/** Rename `local/<oldName>/` to `local/<newName>/` (move contents — OPFS has
	 *  no directory rename). Returns the new directory handle. */
	async function renameProjectDir(
		oldName: string,
		newName: string
	): Promise<FileSystemDirectoryHandle> {
		if (oldName === newName) return createProjectDir(oldName)
		const local = await localDirectoryHandle
		const from = await local.getDirectoryHandle(oldName)
		const to = await local.getDirectoryHandle(newName, {create: true})
		const keys: string[] = []
		for await (const key of from.keys()) keys.push(key)
		for (const key of keys) await moveEntryInto(from, key, to)
		await local.removeEntry(oldName, {recursive: true})
		return to
	}

	/** Recursively copy every entry of `src` into `dest` (no delete). */
	async function copyDirContents(
		src: FileSystemDirectoryHandle,
		dest: FileSystemDirectoryHandle
	) {
		for await (const entry of src.values()) {
			if (entry.kind === 'file') {
				const file = await (entry as FileSystemFileHandle).getFile()
				const out = await dest.getFileHandle(entry.name, {create: true})
				await writeFileWithStream(file, out)
			} else {
				const sub = await dest.getDirectoryHandle(entry.name, {create: true})
				await copyDirContents(entry as FileSystemDirectoryHandle, sub)
			}
		}
	}

	/** Total bytes of all files under `dir` (recursive). */
	async function dirSize(dir: FileSystemDirectoryHandle): Promise<number> {
		let total = 0
		for await (const entry of dir.values()) {
			if (entry.kind === 'file') {
				total += (await (entry as FileSystemFileHandle).getFile()).size
			} else {
				total += await dirSize(entry as FileSystemDirectoryHandle)
			}
		}
		return total
	}

	/** Whether `handle` is an in-app project (a subdirectory of `local/`). */
	async function isWithinLocal(
		handle: FileSystemDirectoryHandle
	): Promise<boolean> {
		const local = await localDirectoryHandle
		if (await local.isSameEntry(handle)) return true
		for await (const entry of local.values()) {
			if (entry.kind === 'directory' && (await entry.isSameEntry(handle))) {
				return true
			}
		}
		return false
	}

	// One-time migration: if a project.json sits directly in local/, move every
	// top-level entry into a new dated subdirectory.
	async function migrateLegacyProject(local: FileSystemDirectoryHandle) {
		let hasLegacy = false
		for await (const [name, h] of local.entries()) {
			if (name === 'project.json' && h.kind === 'file') {
				hasLegacy = true
				break
			}
		}
		if (!hasLegacy) return

		const date = new Date()
		const name =
			`${date.getFullYear()}-` +
			`${String(date.getMonth() + 1).padStart(2, '0')}-` +
			`${String(date.getDate()).padStart(2, '0')}`
		const target = await local.getDirectoryHandle(name, {create: true})

		const keys: string[] = []
		for await (const key of local.keys()) keys.push(key)
		for (const key of keys) {
			if (key === name) continue
			await moveEntryInto(local, key, target)
		}
	}

	// Recursively move `parent/name` into `target/name` (files via move() with a
	// byte-copy fallback; directories by recursing). Used only by migration.
	async function moveEntryInto(
		parent: FileSystemDirectoryHandle,
		name: string,
		target: FileSystemDirectoryHandle
	) {
		let fileHandle: FileSystemFileHandle | null = null
		try {
			fileHandle = await parent.getFileHandle(name)
		} catch {
			fileHandle = null
		}

		if (fileHandle) {
			try {
				await (fileHandle as any).move(target, name)
			} catch {
				const file = await fileHandle.getFile()
				const dest = await target.getFileHandle(name, {create: true})
				await writeFileWithStream(file, dest)
				await parent.removeEntry(name)
			}
			return
		}

		const dir = await parent.getDirectoryHandle(name)
		const destDir = await target.getDirectoryHandle(name, {create: true})
		const keys: string[] = []
		for await (const key of dir.keys()) keys.push(key)
		for (const key of keys) await moveEntryInto(dir, key, destDir)
		await parent.removeEntry(name, {recursive: true})
	}

	const savedFilenameForBlob = new WeakMap<
		FileSystemDirectoryHandle,
		WeakMap<Blob, string>
	>()

	/**
	 * Open the file with the given handler and name. When opening a file, it is also saved in the cache folder within OPFS and then a reference Blob to that file is returned. This allows the file to be opened without any issues even if it is overwritten.
	 */
	async function open(
		directoryHandle: FileSystemDirectoryHandle,
		filename: string
	) {
		if (!directoryHandle) throw new Error('No directory handler')

		// Read the file
		const fileHandle = await directoryHandle.getFileHandle(filename)
		await queryPermission(fileHandle, 'read')
		const file = await fileHandle.getFile()

		// // Check if the file is already saved in the cache directory
		const hash = await hashFile(file)
		let cacheHandle = await getFileIfExists(await tempDirectoryHandle, hash)

		if (!cacheHandle) {
			console.time('caching... ' + filename)
			const newCacheHandle = await tempDirectoryHandle.then(h =>
				h.getFileHandle(hash, {create: true})
			)
			await queryPermission(newCacheHandle)
			await writeFileWithStream(file, newCacheHandle)
			cacheHandle = newCacheHandle
			console.timeEnd('caching... ' + filename)
		}

		let map = savedFilenameForBlob.get(directoryHandle)

		if (!map) {
			map = new WeakMap()
			savedFilenameForBlob.set(directoryHandle, map)
		}

		const cache = await cacheHandle.getFile()
		map.set(cache, filename)

		return cache
	}

	/**
	 * Memoized function for saving a blob to a file.
	 * @returns The filename the blob was saved to.
	 */
	async function save(
		directoryHandle: FileSystemDirectoryHandle,
		filename: string,
		blob: Blob
	) {
		// Check if the blob is already saved with the same name
		let map = savedFilenameForBlob.get(directoryHandle)

		if (!map) {
			map = new WeakMap()
			savedFilenameForBlob.set(directoryHandle, map)
		}

		const savedFilename = savedFilenameForBlob.get(directoryHandle)?.get(blob)

		if (filename !== savedFilename) {
			// Save it to the destination
			const fileHandle = await directoryHandle.getFileHandle(filename, {
				create: true,
			})

			await queryPermission(fileHandle)
			await writeFileWithStream(blob, fileHandle)

			// Save the blob to cache
			map.set(blob, filename)

			// Update the storage usage
			estimateStorage()
		}

		return filename
	}

	return {
		open,
		save,
		localDirectoryHandle,
		listProjectDirs,
		createProjectDir,
		isLocalContainer,
		isWithinLocal,
		deleteProjectDir,
		renameProjectDir,
		copyDirContents,
		dirSize,
		usage,
		quota,
	}
})
