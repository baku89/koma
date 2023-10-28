import {defineStore} from 'pinia'
import {useAppConfigStore} from 'tweeq'
import {computed, ref} from 'vue'

import {useProjectStore} from './project'

export const useTimelineStore = defineStore('timeline', () => {
	const appConfig = useAppConfigStore()
	const project = useProjectStore()

	const currentTool = appConfig.ref<null | 'marker'>(
		'timeline.currentTool',
		'marker'
	)

	const komaWidthBase = ref(60)
	const komaAspect = ref(3 / 2)

	const komaWidth = computed(() => {
		return komaWidthBase.value * project.timeline.zoomFactor
	})

	const komaHeight = computed(() => {
		return Math.round(komaWidthBase.value / komaAspect.value)
	})

	return {
		currentTool,
		komaWidth,
		komaHeight,
	}
})
