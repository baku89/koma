import {Howl} from 'howler'
import {clamp} from 'lodash'
import {defineStore} from 'pinia'
import {computed, ref, shallowRef, watch} from 'vue'

import {refWithSetter} from '@/use/refWithSetter'
import {getObjectURL} from '@/util'

import {useProjectStore} from './project'

type ViewportPopup = null | {type: 'progress'; progress: number}

export const useViewportStore = defineStore('viewport', () => {
	const project = useProjectStore()

	const liveToggle = ref(false)
	const enableHiRes = ref(false)

	const howl = computed(() => {
		if (!project.audio.src) return null

		const src = getObjectURL(project.audio.src)
		return new Howl({src: [src], format: ['wav']})
	})

	const isPlaying = ref(false)

	const isLiveview = computed(() => {
		return previewFrame.value === project.captureShot.frame
	})

	const currentFrame = refWithSetter(0, value => {
		return clamp(value, 0, project.allKomas.length - 1)
	})

	const popup = shallowRef<ViewportPopup>(null)

	// For previewing, live toggle
	const temporalFrame = ref<null | number>(null)

	const previewFrame = computed(() => {
		if (liveToggle.value) {
			if (currentFrame.value === project.captureShot.frame) {
				return project.captureShot.frame - 1
			} else {
				return project.captureShot.frame
			}
		}

		return temporalFrame.value ?? currentFrame.value
	})

	// Play
	watch(isPlaying, () => {
		if (!isPlaying.value) {
			if (!project.isLooping && temporalFrame.value) {
				currentFrame.value = temporalFrame.value
			}
			temporalFrame.value = null
			howl.value?.stop()
			return
		}

		const {
			fps,
			previewRange: [inPoint, outPoint],
		} = project

		if (howl.value) {
			const startSec = (inPoint + 150) / fps
			howl.value.seek(startSec)
			howl.value.play()
		}

		const startTime = new Date().getTime()

		const duration = outPoint - inPoint + 1

		function update() {
			if (!isPlaying.value) {
				temporalFrame.value = null
				return
			}

			const elapsed = new Date().getTime() - startTime

			const elapsedFrames = Math.round((elapsed / 1000) * fps)

			if (!project.isLooping && elapsedFrames >= duration) {
				currentFrame.value = outPoint
				isPlaying.value = false
			} else {
				temporalFrame.value = (elapsedFrames % duration) + inPoint
				requestAnimationFrame(update)
			}
		}

		update()
	})

	// Onionskin information
	const onionskin = computed(() => {
		if (isPlaying.value || liveToggle.value || project.onionskin === 0) {
			return null
		}

		const frameDelta = project.onionskin < 0 ? -1 : 1
		const frame = currentFrame.value + frameDelta
		const shot = project.komas[frame]?.shots[0]

		if (!shot) {
			return null
		}

		const opacity =
			project.onionskin % 1 === 0 ? 1 : Math.abs(project.onionskin) % 1

		return {
			opacity,
			frame,
			shot,
		}
	})

	return {
		liveToggle,
		enableHiRes,
		currentFrame,
		previewFrame,
		isPlaying,
		isLiveview,
		popup,
		onionskin,
	}
})
