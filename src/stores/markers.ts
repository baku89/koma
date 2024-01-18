import {pausableWatch} from '@vueuse/core'
import {defineStore} from 'pinia'
import {reactive, readonly, ref} from 'vue'

import {Marker, useProjectStore} from './project'
import {useSelectionStore} from './selection'
import {useTimelineStore} from './timeline'
import {useViewportStore} from './viewport'

export const useMarkersStore = defineStore('markers', () => {
	const selectedIndices = ref<Set<number>>(new Set())

	const project = useProjectStore()
	const appSelection = useSelectionStore()
	const viewport = useViewportStore()
	const timeline = useTimelineStore()

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

	function select(...indices: number[]) {
		if (indices.length === 0) return

		indices.forEach(index => {
			selectedIndices.value.add(index)
		})

		applyCursorSettingsToSelectionWatcher.pause()
		timeline.toolOptions = {
			...timeline.toolOptions,
			...project.markers[indices.at(-1) ?? 0],
		}
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
			[
				timeline.toolOptions.color,
				timeline.toolOptions.label,
				timeline.toolOptions.duration,
			] as const,
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

	const cursor: Marker = reactive({
		label: '',
		frame: 0,
		verticalPosition: 0.5,
		duration: 0,
		color: '#ffffff',
	})

	return {
		unselect,
		select,
		isSelected,
		selectedIndices: readonly(selectedIndices),
		cursor,
	}
})
