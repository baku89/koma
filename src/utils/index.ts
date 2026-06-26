export * from './assets'
export * from './blob'
export * from './blobJson'
export * from './fileSystem'
export * from './format'
export * from './image'
export * from './promise'
export * from './reactivity'
export * from './sound'
export * from './timer'

import {createDefu} from 'defu'

export const deepMergeExceptArray = createDefu((obj, key, value) => {
	if (Array.isArray(obj[key]) && Array.isArray(value)) {
		obj[key] = value
		return true
	}
})
