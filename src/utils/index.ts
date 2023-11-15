export * from './sound'
export * from './blob'
export * from './promise'
export * from './fileSystem'
export * from './format'

import {createDefu} from 'defu'

export const deepMergeExceptArray = createDefu((obj, key, value) => {
	if (Array.isArray(obj[key]) && Array.isArray(value)) {
		obj[key] = value
		return true
	}
})
