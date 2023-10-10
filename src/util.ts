import {Ref} from 'vue'

export function mapToPromises<T, U>(
	array: T[],
	fn: (item: T, index: number) => Promise<U> | U
): Promise<U[]> {
	return Promise.all(array.map(fn))
}

export function queryString(query: Record<string, string | number>) {
	return Object.entries(query)
		.map(([key, value]) => `${key}=${value}`)
		.join('&')
}

export async function getDirectoryHandle() {
	const handle = await window.showDirectoryPicker({id: 'saveFile'})

	await queryReadWritePermission(handle)

	return handle
}

export async function openBlob(
	handler: Ref<FileSystemDirectoryHandle | null>,
	filename: string
) {
	if (!handler.value) throw new Error('No directory handler')

	const h = await handler.value.getFileHandle(filename)
	return await h.getFile()
}

/**
 * Memoized function for saving a blob to a file.
 * @returns The filename the blob was saved to.
 */
export async function saveBlob(
	handler: Ref<FileSystemDirectoryHandle | null>,
	filename: string,
	blob: Blob
) {
	if (!handler.value) throw new Error('No directory handler')

	if (savedFilenameForBlob.get(blob) === filename) {
		return
	}

	const fileHandle = await handler.value.getFileHandle(filename, {create: true})

	await queryReadWritePermission(fileHandle)

	const w = await fileHandle.createWritable()
	await w.write(blob)
	await w.close()

	savedFilenameForBlob.set(blob, filename)

	return filename
}

const savedFilenameForBlob = new WeakMap<Blob, string>()

/**
 * Query and request readwrite permission for a FileSystemhandle
 */
async function queryReadWritePermission(handle: FileSystemHandle) {
	const permission = await handle.queryPermission({mode: 'readwrite'})

	if (permission !== 'granted') {
		const permission = await handle.requestPermission({mode: 'readwrite'})
		if (permission === 'denied') throw new Error('Permission denied')
	}
}

const urlForBlob = new WeakMap<Blob, string>()

export function getObjectURL(blob: Blob) {
	let url = urlForBlob.get(blob)
	if (!url) {
		url = URL.createObjectURL(blob)
		urlForBlob.set(blob, url)
	}
	return url
}
