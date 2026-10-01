/**
 * Casts the Preview panel to the relay's screens: not the camera's raw live
 * view but what the operator sees — the frame being looked at (seeking),
 * onionskin, layers, playback, with the live view where the capture frame
 * is. The relay sends this stream over WebRTC in place of the camera's.
 *
 * The Preview itself is DOM (`Preview/PreviewKoma.vue`: <img>/<video> with
 * CSS opacity and blend modes), which can't be captured as a stream, so the
 * same composite is drawn here on a canvas at the project resolution and the
 * canvas is captured. Keep the two in step: `komaAt` mirrors PreviewKoma's
 * layer list, `scene` mirrors Preview.vue's stack. Not cast: Hi-Res (always
 * the `lv`), the ZUI pan/zoom of the panel, guides, popups.
 *
 * Nothing is drawn while no screen is watching. A still scene is redrawn
 * once a second (a heartbeat: a screen that joins late gets a frame); with
 * the live view in it, at up to 30 fps. A hidden tab only gets the heartbeat
 * (requestAnimationFrame stops there).
 *
 * When the Preview has nothing in it — an empty frame, the capture frame with
 * no live view — the canvas is left as it is, so the screens hold the last
 * picture instead of going black. Until there has been a first picture, no
 * stream is handed to the relay at all (the screens keep their own last one).
 */

import {defineStore} from 'pinia'
import {computed, readonly, ref, watch} from 'vue'

import {resolveBlob} from '@/utils'

import {useCameraStore} from './camera'
import {useProjectStore} from './project'
import {useRelayStore} from './relay'
import {useViewportStore} from './viewport'

/** Long side of the cast (px); the project resolution when it is smaller. */
const MAX_LONG_SIDE = 1920
const LIVE_INTERVAL_MS = 33
const HEARTBEAT_MS = 1000
const IMAGE_CACHE = 24
const IMAGE_RETRY_MS = 2000

const blendMode = {
	normal: 'source-over',
	lighten: 'lighten',
	darken: 'darken',
	difference: 'difference',
} as const

type CastLayer = ({source: 'live'} | {source: 'image'; id: string}) & {
	opacity: number
	mixBlendMode: keyof typeof blendMode
}

interface CastKoma {
	layers: CastLayer[]
	opacity: number
	/** Coloured onionskin: multiplied over the koma, which is then screened. */
	tint: string | null
}

export const usePreviewCastStore = defineStore('previewCast', () => {
	const project = useProjectStore()
	const viewport = useViewportStore()
	const camera = useCameraStore()
	const relay = useRelayStore()

	const canvas = document.createElement('canvas')
	// One koma is composited here first: its layers blend among themselves,
	// then the group goes on the canvas with the koma's opacity / tint.
	const group = document.createElement('canvas')
	const ctx = canvas.getContext('2d')
	const gctx = group.getContext('2d')
	const stream = canvas.captureStream()
	/** The canvas has had a picture, and the relay has the stream. */
	const offered = ref(false)

	const size = computed<[number, number]>(() => {
		const [w, h] = project.resolution
		const scale = Math.min(1, MAX_LONG_SIDE / Math.max(w, h))
		return [Math.max(2, Math.round(w * scale)), Math.max(2, Math.round(h * scale))]
	})

	/** The composite changed since the last draw. */
	let dirty = true
	let lastDraw = 0

	//--------------------------------------------------------------------------
	// What the Preview shows

	function komaAt(frame: number, opacity: number, tint: string | null): CastKoma | null {
		const {captureShot} = project
		const isCapture = captureShot.frame === frame
		const layers: CastLayer[] = []
		for (const layer of project.compositeLayers(isCapture ? captureShot.layer : viewport.currentLayer)) {
			const view = project.layerView(layer)
			if (isCapture && captureShot.layer === layer) {
				layers.push({source: 'live', ...view})
			} else {
				const id = project.shot(frame, layer)?.lv
				if (id) layers.push({source: 'image', id, ...view})
			}
		}
		return layers.length > 0 ? {layers, opacity, tint} : null
	}

	const scene = computed(() => {
		const komas: (CastKoma | null)[] = []
		// Playing: a shot is on the frame (the playback canvas has it).
		let covered = false
		if (viewport.isPlaying) {
			// The playback canvas is drawn on top; the live view shows through it
			// only on the capture frame when no other layer has a shot there.
			const frame = viewport.previewFrame
			const shots = project.allKomas[frame]?.shots ?? []
			covered = project.compositeLayers(viewport.currentLayer).some(l => shots[l]?.lv)
			if (frame === project.captureShot.frame && !covered) komas.push(komaAt(frame, 1, null))
		} else {
			const tinted =
				viewport.enableOnionskin && viewport.coloredOnionskin && viewport.currentLayer === 0
			komas.push(komaAt(viewport.previewFrame, 1, tinted ? 'red' : null))
			for (const o of viewport.onionskin) komas.push(komaAt(o.frame, o.opacity, o.tint))
		}
		return {
			playing: viewport.isPlaying,
			covered,
			frame: viewport.previewFrame,
			zoom: project.viewport.zoom,
			komas: komas.filter((k): k is CastKoma => k !== null),
		}
	})

	const hasLive = computed(() =>
		scene.value.komas.some(k => k.layers.some(l => l.source === 'live'))
	)

	//--------------------------------------------------------------------------
	// Sources: the live view (a detached <video>) and decoded `lv` images

	const video = document.createElement('video')
	video.muted = true
	video.playsInline = true
	watch(
		() => camera.liveview.value ?? null,
		stream => {
			video.srcObject = stream
			if (stream) void video.play().catch(() => {})
			dirty = true
		},
		{immediate: true}
	)

	function liveReady() {
		return !!video.srcObject && video.readyState >= 2 && video.videoWidth > 0
	}

	const images = new Map<string, ImageBitmap>()
	const loading = new Set<string>()
	const failedAt = new Map<string, number>()

	function image(id: string): ImageBitmap | null {
		const bmp = images.get(id)
		if (bmp) {
			// Most recently used last.
			images.delete(id)
			images.set(id, bmp)
			return bmp
		}
		if (!loading.has(id) && performance.now() - (failedAt.get(id) ?? -Infinity) > IMAGE_RETRY_MS) {
			void load(id)
		}
		return null
	}

	async function load(id: string) {
		loading.add(id)
		try {
			const blob = await resolveBlob(id)
			if (!blob) throw new Error('unresolved')
			images.set(id, await createImageBitmap(blob))
			failedAt.delete(id)
			while (images.size > IMAGE_CACHE) {
				const oldest = images.keys().next().value as string
				images.get(oldest)?.close()
				images.delete(oldest)
			}
			dirty = true
		} catch {
			failedAt.set(id, performance.now())
		} finally {
			loading.delete(id)
		}
	}

	//--------------------------------------------------------------------------
	// Drawing

	/** The Preview's playback canvas (PreviewPlayback.vue), while it is mounted. */
	let playback: HTMLCanvasElement | null = null
	function setPlaybackCanvas(el: HTMLCanvasElement | null) {
		playback = el
	}

	/** `object-fit: cover` */
	function drawCover(
		c: CanvasRenderingContext2D,
		src: CanvasImageSource,
		sw: number,
		sh: number,
		w: number,
		h: number
	) {
		const s = Math.max(w / sw, h / sh)
		c.drawImage(src, (w - sw * s) / 2, (h - sh * s) / 2, sw * s, sh * s)
	}

	function drawKoma(koma: CastKoma, zoom: number) {
		if (!ctx || !gctx) return
		const [w, h] = size.value
		gctx.globalAlpha = 1
		gctx.globalCompositeOperation = 'source-over'
		gctx.clearRect(0, 0, w, h)
		for (const layer of koma.layers) {
			gctx.globalAlpha = layer.opacity
			gctx.globalCompositeOperation = blendMode[layer.mixBlendMode] ?? 'source-over'
			if (layer.source === 'image') {
				const bmp = image(layer.id)
				if (bmp) drawCover(gctx, bmp, bmp.width, bmp.height, w, h)
			} else if (liveReady()) {
				drawCover(gctx, video, video.videoWidth, video.videoHeight, w, h)
			} else {
				// No live view: the Preview shows a black cell there.
				gctx.fillStyle = 'black'
				gctx.fillRect(0, 0, w, h)
			}
		}
		if (koma.tint) {
			gctx.globalAlpha = 1
			gctx.globalCompositeOperation = 'multiply'
			gctx.fillStyle = koma.tint
			gctx.fillRect(0, 0, w, h)
		}
		ctx.globalAlpha = koma.opacity
		ctx.globalCompositeOperation = koma.tint ? 'screen' : 'source-over'
		drawZoomed(group, zoom)
	}

	function drawZoomed(src: HTMLCanvasElement, zoom: number) {
		if (!ctx) return
		const [w, h] = size.value
		ctx.drawImage(src, (w - w * zoom) / 2, (h - h * zoom) / 2, w * zoom, h * zoom)
	}

	/**
	 * Whether the Preview has anything in it: a shot (decoded) or the live
	 * view. It has nothing on an empty frame and on the capture frame with no
	 * live view.
	 */
	function hasPicture() {
		const {komas, playing, covered} = scene.value
		if (playing && covered && playback) return true
		return komas.some(k =>
			k.layers.some(l => (l.source === 'image' ? image(l.id) !== null : liveReady()))
		)
	}

	function render() {
		if (!ctx) return
		const [w, h] = size.value
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = group.width = w
			canvas.height = group.height = h
		}
		if (!hasPicture()) {
			// The last picture stays. For the heartbeat it is drawn onto itself:
			// a captured canvas only sends a frame when something is drawn on it.
			const now = performance.now()
			if (offered.value && now - lastDraw >= HEARTBEAT_MS) {
				ctx.globalAlpha = 1
				ctx.globalCompositeOperation = 'source-over'
				ctx.drawImage(canvas, 0, 0)
				lastDraw = now
			}
			dirty = false
			return
		}
		const {komas, playing, zoom} = scene.value
		ctx.globalAlpha = 1
		ctx.globalCompositeOperation = 'source-over'
		ctx.fillStyle = 'black'
		ctx.fillRect(0, 0, w, h)
		for (const koma of komas) drawKoma(koma, zoom)
		if (playing && playback) {
			ctx.globalAlpha = 1
			ctx.globalCompositeOperation = 'source-over'
			drawZoomed(playback, zoom)
		}
		dirty = false
		lastDraw = performance.now()
		if (!offered.value) {
			offered.value = true
			relay.setLiveStream(stream)
		}
	}

	function tick() {
		const since = performance.now() - lastDraw
		if (dirty || since >= HEARTBEAT_MS || (hasLive.value && since >= LIVE_INTERVAL_MS)) render()
	}

	// Anything the composite is made of changed. `flush: 'post'` so the playback
	// canvas has drawn its frame before the next tick copies it.
	const active = ref(false)

	watch(
		() => (active.value ? [scene.value, size.value] : null),
		() => {
			dirty = true
		},
		{deep: true, flush: 'post'}
	)

	//--------------------------------------------------------------------------
	// Running: only while a screen is watching, or to get the first picture

	let raf = 0
	let heartbeat: ReturnType<typeof setInterval> | undefined

	function frame() {
		tick()
		raf = requestAnimationFrame(frame)
	}

	watch(
		() => relay.liveViewers > 0 || !offered.value,
		on => {
			active.value = on
			cancelAnimationFrame(raf)
			clearInterval(heartbeat)
			if (!on) return
			dirty = true
			raf = requestAnimationFrame(frame)
			// Timers still run (slowly) in a hidden tab, where rAF does not.
			heartbeat = setInterval(tick, HEARTBEAT_MS)
		},
		{immediate: true}
	)

	return {
		stream,
		active: readonly(active),
		setPlaybackCanvas,
	}
})
