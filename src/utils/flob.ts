import {uniqueId} from 'lodash'
import {reactive} from 'vue'

import {queryPermission} from './fileSystem'

export interface Flob {
	uid: string
	content: Blob
}

interface Location {
	filename: string
	directory: FileSystemDirectoryHandle
}

export class FlobManager {
	#tempDirectory: FileSystemDirectoryHandle

	#openedFlob = new WeakMap<FileSystemDirectoryHandle, Map<string, Flob>>()
	#locationForUid = new Map<string, Location>()

	constructor(tempDirectory: FileSystemDirectoryHandle) {
		this.#tempDirectory = tempDirectory
	}

	async open(
		directory: FileSystemDirectoryHandle,
		filename: string
	): Promise<Flob> {
		const cached = this.#getOpenedFlob(directory, filename)

		if (cached) {
			return cached
		}

		const content = await readFileFromDirectory(directory, filename)
		const uid = uniqueId()

		const flob = reactive({uid, content})

		this.#setOpenedFlob(directory, filename, flob)
		this.#locationForUid.set(uid, {filename, directory})

		return flob
	}

	async save(
		directory: FileSystemDirectoryHandle,
		filename: string,
		flob: Flob
	) {
		const existing = this.#getOpenedFlob(directory, filename)

		if (existing) {
			if (existing.uid === flob.uid) {
				return
			}

			// When the file already exists, move it to the temp directory
			const tempFilename = existing.uid + '__' + filename
			const temp = await writeFileToDirectory(
				this.#tempDirectory,
				tempFilename,
				existing.content
			)
			existing.content = temp

			this.#locationForUid.set(existing.uid, {
				directory: this.#tempDirectory,
				filename: tempFilename,
			})
		}

		// Save the new file
		flob.content = await writeFileToDirectory(directory, filename, flob.content)

		// Delete the old file
		const location = this.#locationForUid.get(flob.uid)
		if (location) {
			const {directory, filename} = location
			await directory.removeEntry(filename)
			this.#deleteOpenedFlob(directory, filename)
		}

		// Update the maps
		this.#setOpenedFlob(directory, filename, flob)
		this.#locationForUid.set(flob.uid, {directory, filename})
	}

	create(blob: Blob) {
		return reactive({uid: uniqueId(), content: blob})
	}

	#setOpenedFlob(
		directory: FileSystemDirectoryHandle,
		filename: string,
		flob: Flob
	) {
		let map = this.#openedFlob.get(directory)

		if (!map) {
			map = new Map()
			this.#openedFlob.set(directory, map)
		}

		map.set(filename, flob)
	}

	#getOpenedFlob(directory: FileSystemDirectoryHandle, filename: string) {
		return this.#openedFlob.get(directory)?.get(filename)
	}

	#deleteOpenedFlob(directory: FileSystemDirectoryHandle, filename: string) {
		this.#openedFlob.get(directory)?.delete(filename)
	}
}

async function readFileFromDirectory(
	directory: FileSystemDirectoryHandle,
	filename: string
) {
	const fileHandle = await directory.getFileHandle(filename)
	await queryPermission(fileHandle, 'readwrite')

	return await fileHandle.getFile()
}

async function writeFileToDirectory(
	directory: FileSystemDirectoryHandle,
	filename: string,
	blob: Blob
) {
	const fileHandle = await directory.getFileHandle(filename, {
		create: true,
	})

	await queryPermission(fileHandle, 'readwrite')

	const writer = await fileHandle.createWritable()
	await writer.write(blob)
	await writer.close()

	return await fileHandle.getFile()
}
