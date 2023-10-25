import {pausableWatch} from '@vueuse/core'
import {defineStore} from 'pinia'
import {useActionsStore, useAppConfigStore} from 'tweeq'
import {ref} from 'vue'

import {Marker, useProjectStore} from './project'

export const useMarkersStore = defineStore('markers', () => {
	const selection = ref<Set<number>>(new Set())

	const project = useProjectStore()
	const actions = useActionsStore()
	const appConfig = useAppConfigStore()

	const cursor = appConfig.ref<Marker>('marker.cursor', {
		frame: 0,
		verticalPosition: 0,
		label: 'Marker',
		duration: 1,
		color: 'skyblue',
	})

	function add(marker?: Marker) {
		project.$patch(d => {
			d.markers.push(marker ?? cursor.value)
		})

		return project.markers.length - 1
	}

	function update(index: number, marker: Marker) {
		project.$patch(d => {
			d.markers[index] = marker
		})
	}

	function remove(index: number) {
		project.$patch(d => {
			d.markers.splice(index, 1)
		})
	}

	actions.register([
		{
			id: 'clear_marker_selection',
			input: 'esc',
			perform: clearSelection,
		},
	])

	function clearSelection() {
		selection.value.clear()
	}

	function addSelection(index: number) {
		selection.value.add(index)

		applyCursorSettingsToSelectionWatcher.pause()
		cursor.value = {...project.markers[index]}
		applyCursorSettingsToSelectionWatcher.resume()
	}

	function isSelected(index: number) {
		return selection.value.has(index)
	}

	const applyCursorSettingsToSelectionWatcher = pausableWatch(
		() =>
			[cursor.value.color, cursor.value.label, cursor.value.duration] as const,
		([color, label, duration], [pColor, pLabel, pDuration]) => {
			const changed: Partial<Marker> = {}

			if (color !== pColor) {
				changed.color = color
			}
			if (label !== pLabel) {
				changed.label = label
			}
			if (duration !== pDuration) {
				changed.duration = duration
			}

			if (Object.keys(changed).length === 0 || selection.value.size === 0) {
				return
			}

			project.$patch(d => {
				selection.value.forEach(index => {
					d.markers[index] = {...d.markers[index], ...changed}
				})
			})
		},
		{flush: 'sync'}
	)

	return {
		cursor,
		add,
		update,
		remove,
		clearSelection,
		addSelection,
		isSelected,
	}
})
