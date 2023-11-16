import {pausableWatch} from '@vueuse/core'
import {defineStore} from 'pinia'
import {useAppConfigStore} from 'tweeq'
import {readonly, ref} from 'vue'

import {Marker, useProjectStore} from './project'
import {useSelectionStore} from './selection'
import {useViewportStore} from './viewport'

export const useMarkersStore = defineStore('markers', () => {
	const selectedIndices = ref<Set<number>>(new Set())

	const project = useProjectStore()
	const appSelection = useSelectionStore()
	const viewport = useViewportStore()
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

	function deleteSelected() {
		project.$patch(d => {
			const indices = new Set(selectedIndices.value)
			unselect()
			d.markers = d.markers.filter((_, i) => !indices.has(i))
		})
	}

	function unselect() {
		selectedIndices.value.clear()
	}

	function copy() {
		const markers = [...selectedIndices.value].map(i => project.markers[i])

		const clipboard = {
			type: 'markers',
			data: markers,
		}

		navigator.clipboard.writeText(JSON.stringify(clipboard))
	}

	function addSelection(index: number) {
		selectedIndices.value.add(index)

		applyCursorSettingsToSelectionWatcher.pause()
		cursor.value = {...project.markers[index]}
		applyCursorSettingsToSelectionWatcher.resume()

		appSelection.select({
			context: 'markers',
			onDelete: deleteSelected,
			onUnselect: unselect,
			onCopy: copy,
			onCut() {
				copy()
				deleteSelected()
			},
			async onPaste() {
				const text = await navigator.clipboard.readText()
				const clipboard = JSON.parse(text)

				if (clipboard.type !== 'markers') return

				const markers = clipboard.data as Marker[]

				const minMarkerFrame = Math.min(...markers.map(m => m.frame))

				const markersOffset = markers.map(m => ({
					...m,
					frame: m.frame - minMarkerFrame + viewport.currentFrame,
				}))

				project.$patch(d => {
					d.markers = [...d.markers, ...markersOffset]
				})
			},
		})
	}

	function isSelected(index: number) {
		return selectedIndices.value.has(index)
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

			if (
				Object.keys(changed).length === 0 ||
				selectedIndices.value.size === 0
			) {
				return
			}

			project.$patch(d => {
				selectedIndices.value.forEach(index => {
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
		addSelection,
		isSelected,
		selectedIndices: readonly(selectedIndices),
	}
})
