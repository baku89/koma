// File System Access API utils
export async function openJson<T>(
	handler: FileSystemDirectoryHandle,
	filename: string
): Promise<T> {
	const h = await handler.getFileHandle(filename)
	const f = await h.getFile()
	const text = await f.text()

	return JSON.parse(text)
}

export async function saveJson<T>(
	handler: FileSystemDirectoryHandle,
	filename: string,
	data: T
) {
	const json = JSON.stringify(data)

	const h = await handler.getFileHandle(filename, {
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

export async function writeFileWithStream(
	blob: Blob,
	fileHandle: FileSystemFileHandle
) {
	const writable = await fileHandle.createWritable()

	const reader = blob.stream().getReader()

	// eslint-disable-next-line no-constant-condition
	while (true) {
		const {done, value} = await reader.read()

		if (done) break

		await writable.write(value)
	}

	await writable.close()
}

export async function hashFile(file: File) {
	const chunkSize = 1024 * 50
	const buffer = await file.slice(0, chunkSize).arrayBuffer()
	const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)

	// 16進数に変換
	const hashArray = Array.from(new Uint8Array(hashBuffer))
	const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
	return hashHex
}

export async function getFileIfExists(
	directoryHandle: FileSystemDirectoryHandle,
	fileName: string
) {
	try {
		return await directoryHandle.getFileHandle(fileName)
	} catch (e) {
		return null
	}
}
