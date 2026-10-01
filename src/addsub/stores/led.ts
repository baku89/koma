/**
 * LED wall (ws-fanout over Web Serial). ADDSUB.md §3.3, §8.
 *
 * Holds the connection, the placement map derived from the project's layout
 * params, and `showImage()` which samples an unwrapped lighting image into
 * the wall and resolves once the firmware has latched it (SHOW ack) — the
 * sequence waits on that before capturing.
 *
 * The colours the wall *should* show live in `wall` (one RGB buffer per data
 * line) independently of the hardware: every mode (frame lighting, faces,
 * live feed, work light) writes there first and the device, when connected,
 * is brought up to date from it. So the 3D view previews the lighting with
 * nothing plugged in, and plugging the wall in later just pushes the buffer.
 */

import {defineStore} from 'pinia'
import {computed, readonly, ref, shallowRef, watch} from 'vue'
import {
	CP210X_FILTER,
	type DeviceInfo,
	LINE_ALL,
	type ShowResult,
	WebSerialTransport,
	WsFanout,
} from 'ws-fanout'

import {useProjectStore} from '@/stores/project'
import {
	discoverSerialPorts,
	registerSerialFamily,
	releaseSerialPort,
	requestSerialPort,
	type SerialFamily,
	serialRequestError,
} from '@/utils/serialDiscovery'

import {LED_FACES, type LedFace} from '../config'
import {readProjectBytes} from '../cuts'
import {decodeImage} from '../led/decode'
import {buildLedLayout, ledLayoutFromSet} from '../led/layout'
import {type RgbaImage, sampleLedFrame} from '../led/sampler'
import {decodeWall, encodeWall, wallRecordPath} from '../led/wallRecord'
import type {ShotLedRecord} from '../projectData'
import {usePrevizStore} from './previz'

const FAMILY_ID = 'ws-fanout'

/** `shown.file` while the live feed is on the wall: not a lighting image. */
export const LIVE_SOURCE = 'live'

function clamp255(v: number) {
	return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}

export type ChaseMode = 'pixel' | 'line'

export const useLedStore = defineStore('addsub:led', () => {
	const project = useProjectStore()
	const previz = usePrevizStore()

	const device = shallowRef<WsFanout | null>(null)
	const connecting = ref(false)
	const info = ref<DeviceInfo | null>(null)
	const lastShow = ref<ShowResult | null>(null)
	const lastError = ref<string | null>(null)
	/** Which lighting image is currently on the wall. */
	const shown = ref<{file: string; layoutVersion: number} | null>(null)

	const connected = computed(() => device.value !== null)

	/** The real placement from previz/set.json when present, else the fallback. */
	const layout = computed(() =>
		previz.setLed
			? ledLayoutFromSet(previz.setLed, {rigOffset: project.addsub.calibration.rigOffset})
			: buildLedLayout(project.addsub.led.layout, project.addsub.led.layoutVersion)
	)

	/** world Y = film Y + lift, for the current film lift. */
	const lift = computed(
		() => project.addsub.filmLift + project.addsub.calibration.filmOriginWorld[1]
	)

	//--------------------------------------------------------------------------
	// The wall buffer: what should be lit, per data line (layout line counts)

	function emptyWall() {
		return layout.value.lineCounts.map(n => new Uint8Array(n * 3))
	}

	/** RGB per data line, in ws-fanout line order. Read it with `wallVersion`. */
	const wall = shallowRef<Uint8Array[]>(emptyWall())
	/** Bumped on every change to `wall` (its arrays are mutated in place). */
	const wallVersion = ref(0)

	function touchWall() {
		wallVersion.value++
	}

	/** Copy `lines` into the wall (per line, shorter/longer buffers clipped). */
	function setWall(lines: readonly Uint8Array[]) {
		wall.value.forEach((buf, i) => {
			const src = lines[i]
			if (!src) return
			const n = Math.min(buf.length, src.length - (src.length % 3))
			buf.set(src.subarray(0, n))
		})
		touchWall()
	}

	function fillWall(r: number, g: number, b: number, lines?: readonly number[]) {
		const idx = lines ?? wall.value.map((_, i) => i)
		for (const i of idx) {
			const buf = wall.value[i]
			if (!buf) continue
			for (let o = 0; o < buf.length; o += 3) {
				buf[o] = r
				buf[o + 1] = g
				buf[o + 2] = b
			}
		}
		touchWall()
	}

	/** Mirror the device's local buffer into the wall (after direct writes). */
	function syncWallFromDevice(led: WsFanout) {
		wall.value.forEach((buf, i) => {
			if (i >= led.lineCount) return
			const src = led.getLine(i)
			const n = Math.min(buf.length, src.length)
			buf.set(src.subarray(0, n))
		})
		touchWall()
	}

	/**
	 * Send the wall to the device and wait for the latch. Resolves null when
	 * nothing is connected (the buffer is still the preview). Errors are
	 * recorded in `lastError` and rethrown.
	 */
	async function pushWall(): Promise<ShowResult | null> {
		const led = device.value
		if (!led) return null
		wall.value.forEach((buf, i) => {
			if (i >= led.lineCount) return
			const n = Math.min(buf.length, led.getLine(i).length)
			led.setLine(i, buf.subarray(0, n))
		})
		try {
			const result = await led.show()
			lastError.value = null
			return result
		} catch (e) {
			lastError.value = e instanceof Error ? e.message : String(e)
			throw e
		}
	}

	// The placement changed (set.json, layout params): new line counts.
	watch(
		() => layout.value.lineCounts.join(','),
		() => {
			wall.value = emptyWall()
			touchWall()
			shownKey = null
		}
	)

	//--------------------------------------------------------------------------
	// Connection

	// The transport isn't exposed; track ports ourselves for release.
	const ports = new WeakMap<WsFanout, SerialPort>()
	function port(led: WsFanout): SerialPort {
		return ports.get(led) as SerialPort
	}

	async function probe(port: SerialPort): Promise<boolean> {
		let transport: WebSerialTransport
		try {
			transport = await WebSerialTransport.open({port})
		} catch {
			return false
		}
		try {
			const led = await WsFanout.fromTransport(transport, {bootTimeout: 2500})
			ports.set(led, port)
			adopt(led)
			return true
		} catch {
			await transport.close().catch(() => {})
			return false
		}
	}

	const family: SerialFamily = {
		id: FAMILY_ID,
		label: 'LED Wall',
		wants: () => device.value === null,
		probe,
		holder: p => (device.value && port(device.value) === p ? 'LED Wall' : null),
	}
	registerSerialFamily(family)
	void discoverSerialPorts()

	function adopt(led: WsFanout) {
		device.value = led
		info.value = led.cachedInfo
		lastError.value = null
		led.on('show', r => {
			lastShow.value = r
		})
		led.on('disconnect', () => {
			if (device.value !== led) return
			releaseSerialPort(port(led))
			device.value = null
			info.value = null
			shown.value = null
		})
		// Apply the project's brightness cap; keep applying it when edited.
		void led.setBrightnessCap(project.addsub.led.brightnessCap).catch(() => {})
		checkLineCounts(led.cachedInfo)
	}

	function checkLineCounts(deviceInfo: DeviceInfo) {
		const expected = layout.value.lineCounts
		const actual = deviceInfo.lines.map(l => l.count)
		const mismatch = expected.some((n, i) => actual[i] !== n)
		if (mismatch) {
			lastError.value = `Line counts differ: firmware ${actual.join('/')} vs layout ${expected.join('/')}`
		}
	}

	async function connect() {
		if (device.value || connecting.value) return
		connecting.value = true
		try {
			const result = await requestSerialPort(family, {filters: [CP210X_FILTER]})
			switch (result.status) {
				case 'rejected':
				case 'owned':
					lastError.value = serialRequestError(result)
					break
				case 'adopted':
					if (result.family.id !== FAMILY_ID) {
						lastError.value = `That port is a ${result.family.label} controller — connected it there`
					}
					break
			}
		} finally {
			connecting.value = false
		}
	}

	async function disconnect() {
		await device.value?.disconnect()
	}

	watch(
		() => project.addsub.led.brightnessCap,
		cap => {
			void device.value?.setBrightnessCap(cap).catch(() => {})
		}
	)

	//--------------------------------------------------------------------------
	// Output

	/**
	 * Sample `image` (film coordinates) into the wall and wait for the latch.
	 * Null when no device is connected (the preview is still updated).
	 */
	async function showImage(
		image: RgbaImage,
		ref_: {file: string} | null = null
	): Promise<ShowResult | null> {
		const lines = sampleLedFrame(layout.value, image, {
			topFilmY: project.addsub.led.topFilmY,
			lift: lift.value,
			gain: project.addsub.led.gain,
		})
		setWall(lines)
		shown.value = ref_ ? {file: ref_.file, layoutVersion: layout.value.version} : null
		return pushWall()
	}

	async function showImageBlob(blob: Blob, ref_: {file: string} | null = null) {
		const image = await decodeImage(blob)
		return showImage(image, ref_)
	}

	/**
	 * Put per-pixel colours straight on the wall (no image sampling): one RGB
	 * buffer per data line in line order, or a single buffer of all lines
	 * concatenated (split by the layout's line counts). Short buffers leave
	 * the tail of a line untouched; long ones are truncated. Used by the live
	 * feed from Houdini (§13.2) and by anything that already knows every
	 * pixel's colour.
	 */
	async function showColors(
		colors: Uint8Array | readonly Uint8Array[],
		ref_: {file: string} | null = null
	): Promise<ShowResult | null> {
		const lines: Uint8Array[] = []
		if (colors instanceof Uint8Array) {
			let offset = 0
			for (const buf of wall.value) {
				lines.push(colors.subarray(offset, offset + buf.length))
				offset += buf.length
			}
		} else lines.push(...colors)
		const gain = project.addsub.led.gain
		if (gain !== 1) {
			lines.forEach((rgb, i) => {
				const out = new Uint8Array(rgb.length)
				for (let k = 0; k < rgb.length; k++) out[k] = clamp255(rgb[k] * gain)
				lines[i] = out
			})
		}
		setWall(lines)
		shown.value = ref_ ? {file: ref_.file, layoutVersion: layout.value.version} : null
		return pushWall()
	}

	async function blackout() {
		await fill(0, 0, 0)
	}

	async function fill(r: number, g: number, b: number) {
		fillWall(r, g, b)
		shown.value = null
		const led = device.value
		if (!led) return
		try {
			await led.fill(LINE_ALL, r, g, b)
			lastError.value = null
		} catch (e) {
			lastError.value = e instanceof Error ? e.message : String(e)
			throw e
		}
	}

	//--------------------------------------------------------------------------
	// Manual per-face colours and wiring checks (ADDSUB.md §3.3)

	/** Lines of a face, in ws-fanout line order L1 L2 B1 B2 R1 R2 F1 F2. */
	function linesOfFace(face: LedFace): number[] {
		const n = wall.value.length
		const per = Math.max(1, Math.round(n / LED_FACES.length))
		const i = LED_FACES.indexOf(face)
		return Array.from({length: per}, (_, k) => i * per + k).filter(l => l < n)
	}

	function hexToRgb(hex: string): [number, number, number] {
		const m = /^#?([0-9a-f]{6})/i.exec(hex.trim())
		const v = m ? parseInt(m[1], 16) : 0xffffff
		return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
	}

	/** Fill each face with its colour from the project settings and latch. */
	async function showFaces(): Promise<ShowResult | null> {
		for (const face of LED_FACES) {
			const [r, g, b] = hexToRgb(project.addsub.led.faceColors[face] ?? '#ffffff')
			fillWall(r, g, b, linesOfFace(face))
		}
		shown.value = null
		return pushWall()
	}

	/** Manual per-face colours instead of the frame's lighting. */
	const faceLight = ref(false)

	//--------------------------------------------------------------------------
	// Live feed: per-pixel colours pushed from outside (Houdini over the relay)

	/** Accept live frames; while on they replace faces / follow (work light wins). */
	const liveLight = ref(false)
	/** The last live frame received (kept so toggling live back on re-shows it). */
	const liveFrame = shallowRef<Uint8Array | null>(null)
	const liveInfo = ref<{t: number; fps: number; dropped: number} | null>(null)
	let livePending: Uint8Array | null = null
	let liveShowing = false
	let liveDropped = 0
	let liveLastT = 0

	/**
	 * Feed one frame (all lines concatenated, RGB). Frames that arrive while
	 * one is still being latched are coalesced: only the newest is sent, so
	 * the wall never lags behind a scrubbing timeline. With no device the
	 * frame still goes to the preview buffer.
	 */
	function pushLiveFrame(rgb: Uint8Array) {
		liveFrame.value = rgb
		const now = performance.now()
		const dt = now - liveLastT
		liveLastT = now
		liveInfo.value = {t: Date.now(), fps: dt > 0 ? 1000 / dt : 0, dropped: liveDropped}
		if (!liveLight.value || workLight.value || chasing.value) return
		if (livePending) liveDropped++
		livePending = rgb
		if (!liveShowing) void drainLive()
	}

	async function drainLive() {
		liveShowing = true
		try {
			while (livePending && liveLight.value && !workLight.value) {
				const frame = livePending
				livePending = null
				await enqueue(async () => {
					await showColors(frame, {file: LIVE_SOURCE})
					shownKey = LIVE_SOURCE
				}).catch(() => {})
			}
		} finally {
			liveShowing = false
			livePending = null
		}
	}

	interface ChaseState {
		mode: ChaseMode
		/** Current line and (pixel mode) index. */
		line: number
		index: number
		total: number
	}
	const chasing = ref<ChaseState | null>(null)
	let chaseAbort: AbortController | null = null

	/**
	 * Wiring check: light the wall in order. `pixel` walks one white pixel
	 * through every line (ws-fanout line order, each line from its first
	 * pixel); `line` lights whole lines one after another. Everything else on
	 * the wall is off while it runs; the normal state comes back after.
	 */
	async function startChase(opts: {mode?: ChaseMode; stepMs?: number; line?: number | null} = {}) {
		const led = device.value
		if (!led) throw new Error('LED wall is not connected')
		stopChase()
		const abort = new AbortController()
		chaseAbort = abort
		const mode = opts.mode ?? 'pixel'
		const stepMs = Math.max(20, opts.stepMs ?? 80)
		const lines =
			opts.line === null || opts.line === undefined
				? Array.from({length: led.lineCount}, (_, i) => i)
				: [opts.line]
		const sleep = (ms: number) =>
			new Promise<void>(resolve => {
				if (abort.signal.aborted) return resolve()
				const t = setTimeout(resolve, ms)
				abort.signal.addEventListener(
					'abort',
					() => {
						clearTimeout(t)
						resolve()
					},
					{once: true}
				)
			})
		try {
			await led.fill(LINE_ALL, 0, 0, 0)
			syncWallFromDevice(led)
			for (const line of lines) {
				if (abort.signal.aborted) break
				const count = led.getLine(line).length / 3
				if (mode === 'line') {
					chasing.value = {mode, line, index: 0, total: count}
					led.clear(0, 0, 0, LINE_ALL)
					led.clear(255, 255, 255, line)
					await led.show()
					syncWallFromDevice(led)
					await sleep(stepMs * 10)
					continue
				}
				for (let i = 0; i < count; i++) {
					if (abort.signal.aborted) break
					chasing.value = {mode, line, index: i, total: count}
					if (i > 0) led.setPixel(line, i - 1, 0, 0, 0)
					else led.clear(0, 0, 0, LINE_ALL)
					led.setPixel(line, i, 255, 255, 255)
					await led.show()
					syncWallFromDevice(led)
					await sleep(stepMs)
				}
			}
			if (!abort.signal.aborted) {
				await led.fill(LINE_ALL, 0, 0, 0)
				syncWallFromDevice(led)
			}
		} catch (e) {
			lastError.value = e instanceof Error ? e.message : String(e)
		} finally {
			if (chaseAbort === abort) {
				chaseAbort = null
				chasing.value = null
				shownKey = null
				applyState()
			}
		}
	}

	function stopChase() {
		// Only signal; the running chase clears its own state in its finally.
		chaseAbort?.abort()
	}

	//--------------------------------------------------------------------------
	// Follow the capture frame (ADDSUB.md: 撮影コマに移ったら自動的にその照明) with
	// a temporary all-white work light on top.

	/** Show each capture frame's lighting automatically. */
	const followCapture = ref(true)
	/** Temporary all-white for working on the set; restores the frame after. */
	const workLight = ref(false)

	/** Key of what's in the wall buffer, to skip redundant re-shows. */
	let shownKey: string | null = null
	let chain: Promise<unknown> = Promise.resolve()

	function enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const p = chain.then(fn, fn)
		chain = p.catch(() => {})
		return p
	}

	function frameKey(file: string) {
		return `${file}|${lift.value}|${project.addsub.led.gain}|${project.addsub.led.topFilmY}`
	}

	/**
	 * Make sure `frame`'s lighting is on the wall. Resolves once the firmware
	 * has latched it (or immediately if it already is). Returns false when the
	 * frame has no LED image. The sequence awaits this before capturing.
	 */
	function ensureFrame(frame: number, opts: {force?: boolean} = {}): Promise<boolean> {
		const pf = previz.frameFor(frame)
		if (!pf?.led) return Promise.resolve(false)
		return showFile(pf.led, opts)
	}

	/**
	 * Put a lighting image (path relative to previz/) on the wall, sampled with
	 * the current lift, and wait for the latch. Used to recall the lighting a
	 * shot was taken with (`shot.led.file`), not just the capture frame's.
	 * Without a device only the preview buffer is updated (still true).
	 */
	function showFile(file: string, opts: {force?: boolean} = {}): Promise<boolean> {
		return enqueue(async () => {
			const key = frameKey(file)
			if (!opts.force && shownKey === key && !workLight.value) return true
			const blob = await previz.readBlob(file)
			await showImageBlob(blob, {file})
			shownKey = key
			return true
		})
	}

	function setWorkLight(on: boolean) {
		workLight.value = on
	}

	//--------------------------------------------------------------------------
	// Shot records: the pixels a shot was lit with (led/wallRecord.ts)

	/** Records known to be in the project folder (named by content: write once). */
	let recordedIn: FileSystemDirectoryHandle | null = null
	const recorded = new Set<string>()

	async function saveWallRecord(lines: readonly Uint8Array[]): Promise<string> {
		const encoded = encodeWall(lines)
		const path = await wallRecordPath(encoded)
		if (recordedIn !== project.directoryHandle) recorded.clear()
		if (!recorded.has(path)) {
			await project.writeProjectFile(path, new Blob([encoded as BlobPart]))
			recordedIn = project.directoryHandle
			recorded.add(path)
		}
		return path
	}

	/**
	 * What a shot taken now should remember about its lighting: the image on
	 * the wall, if the light came from one, and — while the wall is connected —
	 * every pixel's RGB as sent (the device's own buffer), saved to the project
	 * folder. The pixels are copied before the first await, so call this at
	 * the exposure and await it later. Never rejects: a record that can't be
	 * written is logged and left out.
	 */
	async function recordForShot(): Promise<ShotLedRecord | undefined> {
		const image = shown.value && shown.value.file !== LIVE_SOURCE ? shown.value : null
		const record: ShotLedRecord = {layoutVersion: image?.layoutVersion ?? layout.value.version}
		if (image) record.file = image.file
		const led = device.value
		if (led) {
			const lines = Array.from({length: led.lineCount}, (_, i) => led.getLine(i).slice())
			record.brightnessCap = project.addsub.led.brightnessCap
			try {
				record.wall = await saveWallRecord(lines)
			} catch (e) {
				// eslint-disable-next-line no-console
				console.error('[led] could not record the wall for this shot', e)
			}
		}
		return record.file || record.wall ? record : undefined
	}

	/**
	 * Put a recorded wall (`shot.led.wall`) back, pixel for pixel — no sampling,
	 * no gain, no lift — and wait for the latch. Lines are clipped to the
	 * current layout. Without a device only the preview buffer is updated.
	 */
	function showWallRecord(file: string): Promise<boolean> {
		return enqueue(async () => {
			const root = project.directoryHandle
			if (!root) throw new Error('The project has no folder')
			const lines = decodeWall(await readProjectBytes(root, file))
			setWall(lines)
			shown.value = null
			await pushWall()
			shownKey = `wall|${file}`
			return true
		})
	}

	/** Put on the wall whatever the current mode says (work > live > faces > frame). */
	function applyState() {
		if (chasing.value) return
		if (workLight.value) {
			if (shownKey === 'work') return
			void enqueue(async () => {
				await fill(255, 255, 255)
				shownKey = 'work'
			}).catch(() => {})
			return
		}
		if (liveLight.value) {
			if (liveFrame.value && shownKey !== LIVE_SOURCE) pushLiveFrame(liveFrame.value)
			return
		}
		if (faceLight.value) {
			const key = `faces|${LED_FACES.map(f => project.addsub.led.faceColors[f]).join(',')}`
			if (shownKey === key) return
			void enqueue(async () => {
				await showFaces()
				shownKey = key
			}).catch(() => {})
			return
		}
		if (followCapture.value) void ensureFrame(project.captureShot.frame).catch(() => {})
	}

	// A device that (re)appears gets the whole buffer, whatever the key says.
	watch(connected, () => {
		shownKey = null
	})

	// Any of these changing re-evaluates what should be on the wall.
	watch(
		() =>
			[
				connected.value,
				workLight.value,
				liveLight.value,
				faceLight.value,
				followCapture.value,
				project.captureShot.frame,
				lift.value,
				project.addsub.led.gain,
				project.addsub.led.topFilmY,
				previz.lastModified,
				layout.value,
				...LED_FACES.map(f => project.addsub.led.faceColors[f]),
			] as const,
		() => applyState(),
		{immediate: true}
	)

	// Manual fills / blackouts invalidate the key so the next ensureFrame
	// really re-sends.
	watch(shown, v => {
		if (v === null) shownKey = null
	})

	return {
		device,
		connected,
		connecting: readonly(connecting),
		info: readonly(info),
		lastShow: readonly(lastShow),
		lastError,
		shown: readonly(shown),
		wall: readonly(wall),
		wallVersion: readonly(wallVersion),
		layout,
		lift,
		connect,
		disconnect,
		showImage,
		showImageBlob,
		showColors,
		blackout,
		fill,
		followCapture,
		workLight,
		setWorkLight,
		faceLight,
		showFaces,
		liveLight,
		liveFrame: readonly(liveFrame),
		liveInfo: readonly(liveInfo),
		pushLiveFrame,
		linesOfFace,
		chasing: readonly(chasing),
		startChase,
		stopChase,
		ensureFrame,
		showFile,
		recordForShot,
		showWallRecord,
	}
})
