import {debounce} from 'lodash'
import {defineStore} from 'pinia'
import {ref} from 'vue'

import {queryPermission} from '@/utils'

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

		resolveLocalDirectoryHandle(
			await root.getDirectoryHandle('local', {create: true})
		)

		const tempDirectoryHandle = await root.getDirectoryHandle('__temp', {
			create: true,
		})

		for await (const key of tempDirectoryHandle.keys()) {
			tempDirectoryHandle.removeEntry(key)
		}

		resolveTempDirectoryHandle(tempDirectoryHandle)

		estimateStorage()
	})()

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
		try {
			const fileHandle = await directoryHandle.getFileHandle(filename)
			await queryPermission(fileHandle, 'read')
			const file = await fileHandle.getFile()

			// Save it to the blob diretory and return the blob
			const cacheName =
				(directoryHandle.name ?? 'originPrivate') + '__' + filename

			const cache = await tempDirectoryHandle
			const cacheHandle = await cache.getFileHandle(cacheName, {create: true})
			await queryPermission(cacheHandle)

			const cacheWriter = await cacheHandle.createWritable()
			await cacheWriter.write(file)
			await cacheWriter.close()

			console.info('Cached the file: ' + filename)

			estimateStorage()

			const cached = await cacheHandle.getFile()

			let map = savedFilenameForBlob.get(directoryHandle)

			if (!map) {
				map = new WeakMap()
				savedFilenameForBlob.set(directoryHandle, map)
			}

			map.set(cached, filename)

			return cached
		} catch (e) {
			throw new Error(
				'Could not open the file: directory=' +
					directoryHandle.name +
					' filename=' +
					filename
			)
		}
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

			const w = await fileHandle.createWritable()
			await w.write(blob)
			await w.close()

			// Save the blob to cache
			map.set(blob, filename)

			// Update the storage usage
			estimateStorage()
		}

		return filename
	}

	return {open, save, localDirectoryHandle, usage, quota}
})
