import {Howl} from 'howler'
import {scalar} from 'linearly'
import {clamp, cloneDeep} from 'lodash-es'
import {defineStore} from 'pinia'
import {useTweeq} from 'tweeq'
import {computed, readonly, ref, shallowRef, watch} from 'vue'

import {
	frameAssetPath,
	getObjectURL,
	imageSignature,
	playSound,
	reencodeImage,
	registerCapturedAsset,
	resizeBlobImage,
	resolveBlob,
	shotsAtOrAfter,
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
		selectionAnchor.value = null
		currentFrame.value = clamp(value, 0, project.allKomas.length - 1)
	}

	function setCurrentLayer(value: number) {
		selectionAnchor.value = null
		currentLayer.value = clamp(value, 0, Math.max(0, project.layers.length - 1))
	}

	// A shift-click extends the selection along the current layer: the anchor
	// is where the selection started, the current frame its other end.
	const selectionAnchor = ref<number | null>(null)

	/** Selected frames on the current layer, inclusive — one frame unless extended. */
	const selectedRange = computed<[number, number] | null>(() => {
		if (!isShotSelected.value) return null
		const a = selectionAnchor.value ?? currentFrame.value
		const b = currentFrame.value
		return [Math.min(a, b), Math.max(a, b)]
	})

	function isFrameSelected(frame: number, layer: number): boolean {
		const r = selectedRange.value
		return !!r && layer === currentLayer.value && r[0] <= frame && frame <= r[1]
	}

	/**
	 * Shift-click: keep the anchor (the frame the selection started at, or the
	 * cursor if nothing was extended yet), move the other end to `frame`, and
	 * (re)register the selection — it may just have been unselected by the
	 * timeline's reserved unselect between pointerdown and click.
	 */
	function extendSelection(frame: number) {
		if (selectionAnchor.value === null) selectionAnchor.value = currentFrame.value
		currentFrame.value = clamp(frame, 0, project.allKomas.length - 1)
		registerShotSelection()
	}

	/** Step to the previous/next *visible* layer in display order. */
	function stepLayer(delta: 1 | -1) {
		const vis = project.visibleLayerIndices
		if (vis.length === 0) return
		const pos = vis.indexOf(currentLayer.value)
		const next = pos === -1 ? vis[0] : vis[clamp(pos + delta, 0, vis.length - 1)]
		currentLayer.value = next
	}

	// Selection
	const isShotSelected = ref(false)

	function selectShot() {
		selectionAnchor.value = null
		registerShotSelection()
	}

	// (Re)register the shot selection with the app-wide selection store. Every
	// pointerdown on the timeline reserves an unselect that only a select() in
	// the same tick cancels — so extending a selection has to register too.
	function registerShotSelection() {
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

	/**
	 * The frames an edit applies to: the selected range, or — on the capture
	 * slot itself, which has no shot yet — the frame before it. Null if nothing
	 * sensible is selected.
	 */
	function framesToEdit(): [number, number] | null {
		const r = selectedRange.value
		if (!r) return null
		let [from, to] = r
		if (
			from === to &&
			from === project.captureShot.frame &&
			!project.shot(from, currentLayer.value)
		) {
			from = to = from - 1
		}
		if (from < 0 || project.duration <= from) return null
		return [from, Math.min(to, project.duration - 1)]
	}

	// Delete: take the selected frames out of the current layer and close the
	// gap on that layer only. Other layers keep their frames (each layer is its
	// own take sharing the numbering), and so does anything keyed by frame.
	// Closing the gap moves every later shot on the layer, which renames their
	// files on the next save (a byte copy of jpg + lv + raw on a folder project,
	// and the kind of edit that wrecked a project on 2026-10-16) — so ask first
	// whenever something would move. Deleting at the end of a layer is free.
	function deleteShot() {
		const r = framesToEdit()
		if (!r) return
		const [from, to] = r
		const layer = currentLayer.value
		const moving = shotsAtOrAfter(project.komas, to + 1, layer)
		if (moving > 0) {
			const name = project.layer(layer).name
			const where = from === to ? `#${from}` : `#${from}–${to}`
			const what = moving === 1 ? '1 shot' : `${moving} shots`
			if (
				!confirm(
					`Delete ${where} on "${name}"?\n\n${what} after it move earlier on this layer (their files are renamed on the next save). Use Cut (⌘X) to blank the cells without moving anything.`
				)
			) {
				return
			}
		}
		project.deleteFrames(from, layer, to - from + 1)
		setCurrentFrame(from)
		playSound('sound/Hit08-1.mp3')
	}

	// Cut/clear in place: blank the selected cells but keep their frames, so
	// nothing ripples.
	function clearShot() {
		const r = framesToEdit()
		if (!r) return
		const [from, to] = r
		const layer = currentLayer.value
		project.$patch(draft => {
			for (let f = from; f <= to; f++) {
				const shots = draft.komas[f]?.shots
				if (shots && shots[layer]) shots[layer] = null
			}
		})
		setCurrentFrame(from)
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
		const filename = frameAssetPath(project, currentLayer.value, currentFrame.value, type)
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
			frameAssetPath(project, layer, frame, 'jpg')
		)
		const lv = registerCapturedAsset(
			lvBlob,
			frameAssetPath(project, layer, frame, 'lv')
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

	// The playback canvas registers this to get the first frames decoded before
	// the clock starts (Preview/PreviewPlayback.vue).
	let playbackPreroll: ((startFrame: number) => Promise<void>) | null = null
	function setPlaybackPreroll(fn: typeof playbackPreroll) {
		playbackPreroll = fn
	}
	/** Longest the start of playback waits for that; then it plays regardless. */
	const PREROLL_TIMEOUT = 1500

	// Play
	let playToken = 0
	watch(isPlaying, async () => {
		const token = ++playToken
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

		let startFrame = currentFrame.value

		if (!project.isLooping && startFrame === outPoint) {
			startFrame = inPoint
		}

		// Starting before the in-point plays the lead-in and then stops at the
		// out-point — you're previewing into the working segment, not stepping out of
		// it. Starting past the out-point means you've left the segment, so ignore the
		// range and play straight through to the end of the project. Either way, no
		// range loop when started outside.
		const startsBeforeRange = startFrame < inPoint
		const startsAfterRange = startFrame > outPoint
		const playEnd = startsAfterRange ? project.allKomas.length - 1 : outPoint
		const canLoop =
			project.isLooping && !startsBeforeRange && !startsAfterRange

		// Show the first frame and let its followers decode, so the first pass
		// doesn't stutter while decoding catches up with the playhead.
		temporalFrame.value = startFrame
		if (playbackPreroll) {
			await Promise.race([
				playbackPreroll(startFrame),
				new Promise(resolve => setTimeout(resolve, PREROLL_TIMEOUT)),
			])
			// Stopped (or stopped and restarted) while waiting.
			if (token !== playToken) return
		}

		let startTime = new Date().getTime()
		const audioTime = (startFrame - audioStartFrame) / fps
		await seekAndPlay(howl.value, audioTime)
		if (token !== playToken) return

		async function update() {
			// Stopped (the branch above cleared the frame), or restarted since.
			if (token !== playToken) return

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
		stepLayer,
		previewFrame,
		temporalFrame,
		isPlaying,
		setPlaybackPreroll,
		isLiveview,
		isShotSelected: readonly(isShotSelected),
		selectedRange,
		isFrameSelected,
		extendSelection,
		popup,
		onionskin,
		selectShot,
	}
})
