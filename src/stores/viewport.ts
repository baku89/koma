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
			if (
				temporalFrame.value &&
				currentFrame.value !== project.captureShot.frame
			) {
				setCurrentFrame(temporalFrame.value)
			}
			temporalFrame.value = null
			howl.value?.stop()
			return
		}

		const {
			fps,
			previewRange: [inPoint, outPoint],
			audio: {startFrame: audioStartFrame},
		} = project

		const audioTime = (currentFrame.value - audioStartFrame) / fps
		await seekAndPlay(howl.value, audioTime)

		let startTime = new Date().getTime()
		let startFrame = currentFrame.value

		if (!project.isLooping && startFrame === outPoint) {
			startFrame = inPoint
		}

		const shouldStopOrLoop = currentFrame.value <= outPoint

		async function update() {
			if (!isPlaying.value) {
				temporalFrame.value = null
				return
			}

			const now = new Date().getTime()
			const elapsedTime = now - startTime

			const elapsedFrames = Math.floor((elapsedTime / 1000) * fps)

			let frame = startFrame + elapsedFrames

			if (shouldStopOrLoop && frame > outPoint) {
				if (project.isLooping) {
					const audioTimeAtInPoint = (inPoint - audioStartFrame) / fps
					await seekAndPlay(howl.value, audioTimeAtInPoint)

					startTime = now
					startFrame = frame = inPoint
				} else {
					setCurrentFrame(outPoint)
					isPlaying.value = false
					return
				}
			}

			temporalFrame.value = frame

			requestAnimationFrame(update)
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
			project.onionskin === 0 ||
			currentLayer.value !== 0
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
