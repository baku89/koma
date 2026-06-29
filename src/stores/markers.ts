import {pausableWatch} from '@vueuse/core'
import {defineStore} from 'pinia'
import {readonly, ref} from 'vue'

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
		endToolOptionEdit()
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
				// Runs on every paste, so bail unless the clipboard actually holds
				// our markers (e.g. it's a copied image, or non-JSON text).
				const text = await navigator.clipboard.readText()
				let clipboard: {type?: string; data?: Marker[]}
				try {
					clipboard = JSON.parse(text)
				} catch {
					return
				}

				if (clipboard?.type !== 'markers') return

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

	// Commit state for the bracketed tool-option edit (see the watcher below).
	let toolEditing = false

	function endToolOptionEdit() {
		if (!toolEditing) return
		toolEditing = false
		project.endInteraction()
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

			// Editing tool options applies to every selected marker, so each tweak
			// (a duration drag, each keystroke) would otherwise fire autosave + a
			// history entry. Bracket it as one interaction: begin lazily here on the
			// first real apply (only when markers are actually selected, so changing
			// the cursor defaults alone never creates a save/undo entry), end on the
			// input's `confirm`. Suspends autosave/history deep-traversal meanwhile.
			if (!toolEditing) {
				toolEditing = true
				project.beginInteraction()
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
		unselect,
		select,
		isSelected,
		endToolOptionEdit,
		selectedIndices: readonly(selectedIndices),
	}
})
