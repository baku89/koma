import {Ref} from 'vue'

// File System Access API utils
export async function loadJson<T>(
	handler: Ref<FileSystemDirectoryHandle | null>,
	filename: string
): Promise<T> {
	if (!handler.value) throw new Error('No directory handler')

	const h = await handler.value.getFileHandle(filename)
	const f = await h.getFile()
	const text = await f.text()

	return JSON.parse(text)
}

export async function saveJson<T>(
	handler: Ref<FileSystemDirectoryHandle | null>,
	filename: string,
	data: T
) {
	if (!handler.value) throw new Error('No directory handler')

	const json = JSON.stringify(data)

	const h = await handler.value.getFileHandle(filename, {
		create: true,
	})

	const w = await h.createWritable()
	await w.write(json)
	await w.close()
}

/**
 * Query and request readwrite permission for a FileSystemHandle
 */
export async function queryPermission(
	handle: FileSystemHandle,
	mode: FileSystemHandlePermissionDescriptor['mode'] = 'readwrite'
) {
	const permission = await handle.queryPermission({mode})

	if (permission !== 'granted') {
		const permission = await handle.requestPermission({mode})
		if (permission === 'denied') throw new Error('Permission denied')
	}
}

export async function showReadwriteDirectoryPicker() {
	const handle = await window.showDirectoryPicker({id: 'saveFile'})

	await queryPermission(handle)

	return handle
}

export async function readFileFromDirectory(
	directory: FileSystemDirectoryHandle,
	filename: string
) {
	const fileHandle = await directory.getFileHandle(filename)
	await queryPermission(fileHandle, 'readwrite')

	return await fileHandle.getFile()
}

export async function writeFileToDirectory(
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
