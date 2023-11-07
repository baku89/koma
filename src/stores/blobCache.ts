import {debounce} from 'lodash'
import {defineStore} from 'pinia'
import {Ref, ref} from 'vue'

import {queryPermission} from '@/utils'

export const useBlobStore = defineStore('blobCache', () => {
	let resolveLocalDirectoryHandle: (
		value: FileSystemDirectoryHandle
	) => void = () => null
	let resolveBlobCacheHandle: (value: FileSystemDirectoryHandle) => void = () =>
		null

	const localDirectoryHandle: Promise<FileSystemDirectoryHandle> = new Promise(
		resolve => {
			resolveLocalDirectoryHandle = resolve
		}
	)
	const blobCacheHandle: Promise<FileSystemDirectoryHandle> = new Promise(
		resolve => {
			resolveBlobCacheHandle = resolve
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

		const blobCacheHandle = await root.getDirectoryHandle('__blobCache', {
			create: true,
		})

		for await (const key of blobCacheHandle.keys()) {
			blobCacheHandle.removeEntry(key)
		}

		resolveBlobCacheHandle(blobCacheHandle)

		estimateStorage()
	})()

	/**
	 * Open the file with the given handler and name. When opening a file, it is also saved in the cache folder within OPFS and then a reference Blob to that file is returned. This allows the file to be opened without any issues even if it is overwritten.
	 */
	async function open(
		handler: Ref<FileSystemDirectoryHandle | null>,
		filename: string
	) {
		if (!handler.value) throw new Error('No directory handler')

		// Read the file
		try {
			const fileHandle = await handler.value.getFileHandle(filename)
			await queryPermission(fileHandle, 'read')
			const file = await fileHandle.getFile()

			// Save it to the blob diretory and return the blob
			const cacheName =
				(handler.value.name ?? 'originPrivate') + '__' + filename

			const cache = await blobCacheHandle
			const cacheHandle = await cache.getFileHandle(cacheName, {create: true})
			await queryPermission(cacheHandle)

			const cacheWriter = await cacheHandle.createWritable()
			await cacheWriter.write(file)
			await cacheWriter.close()

			estimateStorage()

			return await cacheHandle.getFile()
		} catch (e) {
			throw new Error(
				'Could not open the file: directory=' +
					handler.value.name +
					' filename=' +
					filename
			)
		}
	}

	const savedFilenameForBlob = new WeakMap<
		FileSystemDirectoryHandle,
		WeakMap<Blob, string>
	>()

	/**
	 * Memoized function for saving a blob to a file.
	 * @returns The filename the blob was saved to.
	 */
	async function save(
		handler: Ref<FileSystemDirectoryHandle | null>,
		filename: string,
		blob: Blob
	) {
		if (!handler.value) throw new Error('No directory handler')

		// Check if the blob is already saved with the same name
		let map = savedFilenameForBlob.get(handler.value)

		if (!map) {
			map = new WeakMap()
			savedFilenameForBlob.set(handler.value, map)
		}

		const savedFilename = savedFilenameForBlob.get(handler.value)?.get(blob)

		if (filename !== savedFilename) {
			// Save it to the destination
			const fileHandle = await handler.value.getFileHandle(filename, {
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
