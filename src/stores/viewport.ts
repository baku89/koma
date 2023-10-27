import {Howl} from 'howler'
import {scalar} from 'linearly'
import {clamp} from 'lodash'
import {defineStore} from 'pinia'
import {useAppConfigStore} from 'tweeq'
import {computed, readonly, ref, shallowRef, watch} from 'vue'

import {getObjectURL} from '@/util'
import {scrub, seekAndPlay} from '@/utils'

import {useProjectStore} from './project'

type ViewportPopup = null | {type: 'progress'; progress: number}

export const useViewportStore = defineStore('viewport', () => {
	const project = useProjectStore()

	const liveToggle = ref(false)
	const enableOnionskin = ref(true)
	const enableHiRes = ref(false)
	const appConfig = useAppConfigStore()

	const howl = computed(() => {
		if (!project.audio.src) return null

		const src = getObjectURL(project.audio.src)
		return new Howl({src: [src], format: ['wav']})
	})

	const isPlaying = ref(false)

	const isLiveview = computed(() => {
		return previewFrame.value === project.captureShot.frame
	})

	const currentFrame = appConfig.ref('viewprot.currentFrame', 0)
	const currentLayer = appConfig.ref('viewport.currentLayer', 0)

	function setCurrentFrame(value: number) {
		currentFrame.value = clamp(value, 0, project.allKomas.length - 1)
	}

	function setCurrentLayer(value: number) {
		currentLayer.value = clamp(value, 0, 1)
	}

	const popup = shallowRef<ViewportPopup>(null)

	/** For previewing, live toggle. */
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
	watch(isPlaying, async () => {
		if (!isPlaying.value) {
			if (!project.isLooping && temporalFrame.value) {
				setCurrentFrame(temporalFrame.value)
			}
			temporalFrame.value = null
			howl.value?.stop()
			return
		}

		const {
			fps,
			previewRange: [inPoint, outPoint],
			audio: {startFrame},
		} = project

		if (howl.value) {
			const startSec = (inPoint - startFrame) / fps
			await seekAndPlay(howl.value, startSec)
		}

		let startTime = new Date().getTime()

		const duration = outPoint - inPoint + 1

		async function update() {
			if (!isPlaying.value) {
				temporalFrame.value = null
				return
			}

			const now = new Date().getTime()
			const elapsed = now - startTime

			let elapsedFrames = Math.round((elapsed / 1000) * fps)

			if (!project.isLooping && elapsedFrames >= duration) {
				setCurrentFrame(outPoint)
				isPlaying.value = false
			} else {
				if (elapsedFrames >= duration) {
					if (howl.value) {
						await seekAndPlay(howl.value, (inPoint - startFrame) / fps)
					}
					startTime = now
					elapsedFrames = 0
				}

				temporalFrame.value = (elapsedFrames % duration) + inPoint
				requestAnimationFrame(update)
			}
		}

		update()
	})

	// Audio scrub
	watch(currentFrame, currentFrame => {
		if (!howl.value) return

		scrub(
			howl.value,
			(currentFrame - project.audio.startFrame) / project.fps,
			1000 / 15
		)
	})

	// Onionskin information
	const onionskin = computed<{frame: number; opacity: number}[]>(() => {
		if (
			isPlaying.value ||
			liveToggle.value ||
			!enableOnionskin.value ||
			project.onionskin === 0
		) {
			return []
		}

		const {onionskin} = project

		const o = Math.abs(onionskin)
		const dir = Math.sign(onionskin)
		const fract = o % 1.0 === 0 ? 1 : o % 1.0

		const counts = Math.ceil(o - 0.0001)
		const layers = Array(counts)
			.fill(0)
			.map((_, i) => {
				const frame = currentFrame.value + dir * (i + 1)
				const opacityFrom = i === counts - 1 ? 0 : 1 / counts
				const opacityTarget = 1 / (counts + 1)
				const opacity = scalar.lerp(opacityFrom, opacityTarget, fract)

				return {frame, opacity}
			})

		return layers
	})

	return {
		liveToggle,
		enableHiRes,
		enableOnionskin,
		currentFrame: readonly(currentFrame),
		setCurrentFrame,
		currentLayer: readonly(currentLayer),
		setCurrentLayer,
		previewFrame,
		isPlaying,
		isLiveview,
		popup,
		onionskin,
	}
})
