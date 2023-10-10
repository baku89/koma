import {clamp} from 'lodash'
import {defineStore} from 'pinia'
import {computed, ref, watch} from 'vue'

import {refWithSetter} from '@/use/refWithSetter'

import {useProjectState} from './project'

export const useViewportStore = defineStore('viewport', () => {
	const project = useProjectState()

	const liveToggle = ref(false)
	const enableHiRes = ref(false)

	const isLooping = ref(false)
	const isPlaying = ref(false)

	const isLiveview = computed(() => {
		return previewFrame.value === project.captureFrame
	})

	const currentFrame = refWithSetter(0, value => {
		return clamp(value, 0, project.allKomas.length - 1)
	})

	// For previewing, live toggle
	const temporalFrame = ref<null | number>(null)

	const previewFrame = computed(() => {
		if (liveToggle.value) {
			if (currentFrame.value === project.captureFrame) {
				return project.captureFrame - 1
			} else {
				return project.captureFrame
			}
		}

		return temporalFrame.value ?? currentFrame.value
	})

	// Play
	watch(isPlaying, () => {
		if (!isPlaying.value) {
			temporalFrame.value = null
			return
		}

		const startTime = new Date().getTime()

		const [inPoint, outPoint] = project.state.previewRange
		const duration = outPoint - inPoint + 1
		const {fps} = project.data

		function update() {
			if (!isPlaying.value) {
				temporalFrame.value = null
				return
			}

			const elapsed = new Date().getTime() - startTime

			const elapsedFrames = Math.round((elapsed / 1000) * fps)

			if (!isLooping.value && elapsedFrames >= duration) {
				currentFrame.value = outPoint
				isPlaying.value = false
			} else {
				temporalFrame.value = (elapsedFrames % duration) + inPoint
				requestAnimationFrame(update)
			}
		}

		update()
	})

	return {
		liveToggle,
		enableHiRes,
		currentFrame,
		previewFrame,
		isPlaying,
		isLooping,
		isLiveview,
	}
})
