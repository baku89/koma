import {defineStore} from 'pinia'
import {useActionsStore, useAppConfigStore} from 'tweeq'
import {computed, ref} from 'vue'

import {useProjectStore} from './project'

export const useTimelineStore = defineStore('timeline', () => {
	const appConfig = useAppConfigStore()
	const project = useProjectStore()
	const actions = useActionsStore()

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

	actions.register([
		{
			id: 'timeline',
			icon: 'material-symbols:view-timeline',
			children: [
				{
					id: 'enable_timeline_marker_tool',
					shortLabel: 'Marker Tool',
					bind: 'm',
					icon: 'mdi:marker',
					perform() {
						currentTool.value = 'marker'
					},
				},
				{
					id: 'enable_timeline_select_tool',
					shortLabel: 'Select Tool',
					bind: 'v',
					icon: 'ph:cursor-fill',
					perform() {
						currentTool.value = null
					},
				},
			],
		},
	])

	return {
		currentTool,
		komaWidth,
		komaHeight,
	}
})
