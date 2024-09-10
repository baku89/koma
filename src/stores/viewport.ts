import {Howl} from 'howler'
import {scalar} from 'linearly'
import {clamp} from 'lodash'
import {defineStore} from 'pinia'
import {useTweeq} from 'tweeq'
import {computed, readonly, ref, shallowRef, watch} from 'vue'

import {getObjectURL, playSound} from '@/utils'
import {scrub, seekAndPlay} from '@/utils'

import {useProjectStore} from './project'
import {useSelectionStore} from './selection'

type ViewportPopup = null | {type: 'progress'; progress: number}

export const useViewportStore = defineStore('viewport', () => {
	const project = useProjectStore()

	const liveToggle = ref(false)
	const enableOnionskin = ref(true)
	const enableHiRes = ref(false)
	const config = useTweeq().config.group('viewport')
	const appSelection = useSelectionStore()

	const howl = computed(() => {
		if (!project.audio.src) return null

		const src = getObjectURL(project.audio.src)
		return new Howl({src: [src], format: ['wav']})
	})

	const isPlaying = ref(false)

	const isLiveview = computed(() => {
		return previewFrame.value === project.captureShot.frame
	})

	const currentFrame = config.ref('currentFrame', 0)
	const currentLayer = config.ref('currentLayer', 0)
	const coloredOnionskin = config.ref('coloredOnionskin', false)

	function setCurrentFrame(value: number) {
		currentFrame.value = clamp(value, 0, project.allKomas.length - 1)
	}

	function setCurrentLayer(value: number) {
		currentLayer.value = clamp(value, 0, 1)
	}

	// Selection
	const isShotSelected = ref(false)

	function selectShot() {
		isShotSelected.value = true

		appSelection.select({
			context: 'shot',
			onDelete: deleteShot,
			onUnselect: unselectShot,
		})
	}

	function unselectShot() {
		isShotSelected.value = false
	}

	function deleteShot() {
		if (!isShotSelected.value) return

		const isDeletingCaptureFrame =
			currentFrame.value === project.captureShot.frame

		const frameToDelete = isDeletingCaptureFrame
			? currentFrame.value - 1
			: currentFrame.value

		if (frameToDelete < 0 || project.duration <= frameToDelete) {
			return
		}

		project.$patch(draft => {
			draft.komas[frameToDelete].shots.splice(currentLayer.value, 1)

			const shouldDeleteKoma = draft.komas[frameToDelete].shots.length === 0

			if (shouldDeleteKoma) {
				// Equivalent to `draft.komas.splice(frameToDelete, 1)`,
				// but it is way more faster.
				draft.komas = [
					...draft.komas.slice(0, frameToDelete),
					...draft.komas.slice(frameToDelete + 1),
				]

				if (
					isDeletingCaptureFrame &&
					currentFrame.value === draft.captureShot.frame
				) {
					setCurrentFrame(currentFrame.value - 1)
				}
				if (frameToDelete < draft.captureShot.frame) {
					draft.captureShot.frame -= 1
				}
				if (frameToDelete <= draft.previewRange[1]) {
					draft.previewRange[1] -= 1
				}
			}
		})

		playSound('sound/Hit08-1.mp3')
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

		let startTime = new Date().getTime()
		let startFrame = currentFrame.value

		if (!project.isLooping && startFrame === outPoint) {
			startFrame = inPoint
		}

		const audioTime = (startFrame - audioStartFrame) / fps
		await seekAndPlay(howl.value, audioTime)

		async function update() {
			if (!isPlaying.value) {
				temporalFrame.value = null
				return
			}

			const now = new Date().getTime()
			const elapsedTime = now - startTime

			const elapsedFrames = Math.floor((elapsedTime / 1000) * fps)

			let frame = startFrame + elapsedFrames

			if (frame > outPoint) {
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
	const onionskin = computed(() => {
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

		const count = Number.isInteger(o) ? o : Math.ceil(o)
		const layers = Array(count)
			.fill(0)
			.map((_, i) => {
				const frame = currentFrame.value + dir * (i + 1)

				if (coloredOnionskin.value) {
					const hueFrom = scalar.lerp(0, 360, (i + 1) / count)
					const hueTarget = scalar.lerp(0, 360, (i + 1) / (count + 1))
					const hue = scalar.lerp(hueFrom, hueTarget, fract)

					const opacityFrom = i === count - 1 ? 0 : 1
					const opacity = scalar.lerp(opacityFrom, 1, fract)

					return {
						frame,
						opacity,
						tint: `hsl(${hue}, 100%, 50%)`,
					}
				} else {
					const opacityFrom = i === count - 1 ? 0 : 1 / count
					const opacityTarget = 1 / (count + 1)
					const opacity = scalar.lerp(opacityFrom, opacityTarget, fract)
					return {frame, opacity, tint: null}
				}
			})

		return layers
	})

	return {
		liveToggle,
		enableHiRes,
		enableOnionskin,
		coloredOnionskin,
		currentFrame: readonly(currentFrame),
		setCurrentFrame,
		currentLayer: readonly(currentLayer),
		setCurrentLayer,
		previewFrame,
		isPlaying,
		isLiveview,
		isShotSelected: readonly(isShotSelected),
		popup,
		onionskin,
		selectShot,
	}
})
