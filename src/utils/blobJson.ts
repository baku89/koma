import {isArray, isPlainObject} from 'lodash'

import {openJson, readFileFromDirectory, saveJson} from './fileSystem'
import {mapPromises, mapValuePromises} from './promise'

type Path = (string | number)[]

interface SaveBlobJsonOptions {
	pathToFilename?: (path: Path) => string | undefined
	saveBlob: (
		directoryHandle: FileSystemDirectoryHandle,
		filename: string,
		blob: Blob
	) => Promise<any>
}

interface OpenBlobJsonOptions {
	openBlob: (
		directoryHandle: FileSystemDirectoryHandle,
		filename: string
	) => Promise<Blob>
}

type Json = string | number | boolean | null | Json[] | {[key: string]: Json}

type UnflatData =
	| string
	| number
	| boolean
	| null
	| Blob
	| UnflatData[]
	| {[key: string]: UnflatData}

/**
 * Save the given data as a JSON file. If the data contains a Blob, it will be saved as a separated file in the given directory and the path to the file will be stored instead.
 */
export async function saveBlobJson(
	directoryHandle: FileSystemDirectoryHandle,
	data: any,
	options: SaveBlobJsonOptions
) {
	const json = await flat(data)

	saveJson(directoryHandle, 'project.json', json)

	async function flat(data: any, path: Path = []): Promise<Json> {
		if (isArray(data)) {
			return mapPromises(data, (value, index) => flat(value, [...path, index]))
		} else if (isPlainObject(data)) {
			return mapValuePromises(data, (value, key) => flat(value, [...path, key]))
		} else if (data instanceof Blob) {
			let filename = options.pathToFilename?.(path) ?? path.join('.')

			if (data instanceof File && data.name.includes('.')) {
				const ext = data.name.split('.').pop()

				if (ext && !filename.endsWith(`.${ext}`)) {
					filename += `.${ext}`
				}
			}

			await options.saveBlob(directoryHandle, filename, data)
			return {
				$type: 'blob',
				filename,
			}
		} else {
			return data
		}
	}
}

/**
 * Load the JSON file and replace the path to the Blob with the Blob itself if necessary
 */
export async function openBlobJson(
	directoryHandle: FileSystemDirectoryHandle,
	options: OpenBlobJsonOptions
) {
	const json = await openJson(directoryHandle, 'project.json')
	return unflat(json as any)

	async function unflat(data: Json): Promise<UnflatData> {
		if (isArray(data)) {
			return mapPromises(data, value => unflat(value))
		} else if (typeof data === 'object' && data !== null) {
			if (data.$type === 'blob') {
				return options.openBlob(directoryHandle, data.filename as string)
			} else {
				return mapValuePromises(data, value => unflat(value))
			}
		} else {
			if (typeof data === 'string' && data.match(/\.(jpg|dng)$/)) {
				return readFileFromDirectory(directoryHandle, data)
			} else {
				return data
			}
		}
	}
}
