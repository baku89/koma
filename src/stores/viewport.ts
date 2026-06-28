import {Howl} from 'howler'
import {scalar} from 'linearly'
import {clamp, cloneDeep} from 'lodash-es'
import {defineStore} from 'pinia'
import {useTweeq} from 'tweeq'
import {computed, readonly, ref, shallowRef, watch} from 'vue'

import {
	frameAssetFilename,
	getObjectURL,
	imageSignature,
	playSound,
	reencodeImage,
	registerCapturedAsset,
	resizeBlobImage,
	resolveBlob,
} from '@/utils'
import {scrub, seekAndPlay} from '@/utils'

import {type Shot, useProjectStore} from './project'
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
			onCopy: copyShot,
			async onCut() {
				await copyShot()
				clearShot()
			},
			onPaste: pasteShot,
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

	// Cut/clear a shot in place: blank the cell but keep its frame, so the
	// timeline doesn't ripple shut. Unlike deleteShot, an emptied frame is left
	// as an empty koma rather than spliced out.
	function clearShot() {
		if (!isShotSelected.value) return

		const frame =
			currentFrame.value === project.captureShot.frame
				? currentFrame.value - 1
				: currentFrame.value

		if (frame < 0 || project.duration <= frame) return

		project.$patch(draft => {
			draft.komas[frame].shots[currentLayer.value] = null
		})

		playSound('sound/Hit08-1.mp3')
	}

	// In-app clipboard for a copied shot, matched to the system clipboard by a
	// content signature. We can't put our own marker on the clipboard (Chrome
	// can't write image/jpeg, and a `web ...` custom format hangs the write), and
	// the clipboard re-encodes images so byte/hash comparison fails — hence a
	// re-encode-stable downsample signature.
	let clipboardShot: {sig: string; shot: Shot} | null = null

	async function copyShot() {
		const shot = project.shot(currentFrame.value, currentLayer.value)
		if (!shot) return

		const src = await resolveBlob(shot.jpg)
		if (!src) return

		// Full-resolution PNG so other apps get the real image (not the low-res
		// lv). Chrome rejects image/jpeg on write and hangs on custom formats, so
		// the clipboard holds a lone PNG and nothing else.
		const png = await reencodeImage(src, 'image/png')
		clipboardShot = {sig: await imageSignature(png), shot: cloneDeep(shot)}

		try {
			await navigator.clipboard.write([new ClipboardItem({'image/png': png})])
		} catch (err) {
			// In-app copy still works even if the system clipboard write fails.
			// eslint-disable-next-line no-console
			console.error('Clipboard write failed:', err)
		}
	}

	async function pasteShot() {
		let items: ClipboardItem[]
		try {
			items = await navigator.clipboard.read()
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error('Clipboard read failed:', err)
			return
		}

		for (const item of items) {
			const imageType = item.types.find(t => t.startsWith('image/'))
			if (!imageType) continue
			const blob = await item.getType(imageType)

			// Our own copy (clipboard image depicts the shot we copied) → restore
			// the full shot (lv/jpg/raw/metadata). Otherwise it's an image from
			// another app → import it.
			if (clipboardShot && (await imageSignature(blob)) === clipboardShot.sig) {
				await pasteShotData(clipboardShot.shot)
			} else {
				await pasteExternalImage(blob)
			}
			return
		}
	}

	// Duplicate an asset (new id + fresh in-memory copy) so a pasted shot is
	// independent of its source.
	async function duplicateAsset(
		assetId: string,
		type: 'lv' | 'jpg' | 'raw'
	): Promise<string | undefined> {
		const blob = await resolveBlob(assetId)
		if (!blob) return undefined
		const filename = frameAssetFilename(
			project.name,
			currentLayer.value,
			currentFrame.value,
			type
		)
		return registerCapturedAsset(blob, filename)
	}

	async function pasteShotData(src: Shot) {
		const lv = await duplicateAsset(src.lv, 'lv')
		const jpg = await duplicateAsset(src.jpg, 'jpg')
		if (!lv || !jpg) return
		const raw = src.raw ? await duplicateAsset(src.raw, 'raw') : undefined

		project.setShot(currentFrame.value, currentLayer.value, {
			...cloneDeep(src),
			lv,
			jpg,
			raw,
		})
		playSound('sound/Hit08-1.mp3')
	}

	async function pasteExternalImage(blob: Blob) {
		const frame = currentFrame.value
		const layer = currentLayer.value

		const jpeg = await reencodeImage(blob, 'image/jpeg')
		const lvBlob = await resizeBlobImage(jpeg, project.resolution, 'cover')

		const jpg = registerCapturedAsset(
			jpeg,
			frameAssetFilename(project.name, layer, frame, 'jpg')
		)
		const lv = registerCapturedAsset(
			lvBlob,
			frameAssetFilename(project.name, layer, frame, 'lv')
		)

		project.setShot(frame, layer, {lv, jpg, captureDate: Date.now()})
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

		// Starting outside the preview range (before the in-point or past the
		// out-point) means you've stepped out of the working segment, so ignore the
		// range and play straight through to the end of the project (no range loop).
		const outsideRange = startFrame < inPoint || startFrame > outPoint
		const playEnd = outsideRange ? project.allKomas.length - 1 : outPoint
		const canLoop = project.isLooping && !outsideRange

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

			if (frame > playEnd) {
				if (canLoop) {
					const audioTimeAtInPoint = (inPoint - audioStartFrame) / fps
					await seekAndPlay(howl.value, audioTimeAtInPoint)

					startTime = now
					startFrame = frame = inPoint
				} else {
					setCurrentFrame(playEnd)
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
		temporalFrame,
		isPlaying,
		isLiveview,
		isShotSelected: readonly(isShotSelected),
		popup,
		onionskin,
		selectShot,
	}
})
