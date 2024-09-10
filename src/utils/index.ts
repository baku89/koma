export * from './sound'
export * from './blob'
export * from './promise'
export * from './fileSystem'
export * from './reactivity'
export * from './format'
export * from './blobJson'
export * from './flob'
export * from './image'
export * from './timer'

import {createDefu} from 'defu'

export const deepMergeExceptArray = createDefu((obj, key, value) => {
	if (Array.isArray(obj[key]) && Array.isArray(value)) {
		obj[key] = value
		return true
	}
})
