import {defineStore} from 'pinia'
import {useAppConfigStore} from 'tweeq'

export const useTimelineStore = defineStore('timeline', () => {
	const appConfig = useAppConfigStore()

	const currentTool = appConfig.ref<null | 'marker'>(
		'timeline.currentTool',
		'marker'
	)

	return {
		currentTool,
	}
})
