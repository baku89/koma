import {defineStore} from 'pinia'
import {useTweeq} from 'tweeq'
import {computed, ref} from 'vue'

import {type Marker, useProjectStore} from './project'

interface PencilOption {
	color: string
}

export const useTimelineStore = defineStore('timeline', () => {
	const Tq = useTweeq()
	const project = useProjectStore()

	const currentTool = Tq.config.ref<'select' | 'marker' | 'pencil' | 'eraser'>(
		'timeline.currentTool',
		'select'
	)

	const toolOptions = Tq.config.ref<Marker & PencilOption>('tool.options', {
		frame: 0,
		verticalPosition: 0,
		label: 'Marker',
		duration: 1,
		color: 'skyblue',
	})

	const frameWidthBase = ref(60)
	const komaAspect = ref(3 / 2)

	const frameWidth = computed({
		get() {
			return frameWidthBase.value * project.timeline.zoomFactor
		},
		set(value) {
			project.timeline.zoomFactor = value / frameWidthBase.value
		},
	})

	const layerHeight = computed(() => {
		return Math.round(frameWidthBase.value / komaAspect.value)
	})

	Tq.actions.register([
		{
			id: 'timeline',
			icon: 'material-symbols:view-timeline',
			children: [
				{
					id: 'enable_timeline_select_tool',
					shortLabel: 'Select Tool',
					bind: 'v',
					icon: 'ph:cursor-fill',
					perform() {
						currentTool.value = 'select'
					},
				},
				{
					id: 'enable_timeline_marker_tool',
					shortLabel: 'Marker Tool',
					bind: 'm',
					icon: 'subway:mark',
					perform() {
						currentTool.value = 'marker'
					},
				},
				{
					id: 'enable_timeline_pencil_tool',
					shortLabel: 'Pencil Tool',
					bind: 'g',
					icon: 'mdi:pencil',
					perform() {
						currentTool.value = 'pencil'
					},
				},
				{
					id: 'enable_timeline_eraser_tool',
					shortLabel: 'Eraser Tool',
					bind: 'e',
					icon: 'mdi:eraser',
					perform() {
						currentTool.value = 'eraser'
					},
				},
			],
		},
	])

	return {
		currentTool,
		toolOptions,
		frameWidth,
		frameWidthBase,
		layerHeight,
	}
})
