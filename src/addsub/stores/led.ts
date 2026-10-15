/**
 * LED wall (ws-fanout over Web Serial). ADDSUB.md §3.3, §8.
 *
 * Holds the connection, the placement map (led/layout.ts, hard-coded) and
 * what is lit. `mode` picks one source — off (nothing of koma's: the wall
 * keeps what it shows), work light (all white), live (per-pixel colours from
 * Houdini), faces (one colour per face) — and a recorded shot's pixels or a
 * manual fill can be put up at any time (they drop the mode to off). Every
 * show resolves once the firmware has latched it (SHOW ack) — the sequence
 * waits on that before capturing.
 *
 * The colours the wall *should* show live in `wall` (one RGB buffer per data
 * line) independently of the hardware: every mode writes there first and the
 * device, when connected, is brought up to date from it. So the 3D view previews the lighting with
 * nothing plugged in, and plugging the wall in later just pushes the buffer.
 *
 * The driver board itself remembers the last frame (ws-fanout firmware ≥ 0.2
 * keeps it in flash and lights the wall with it whenever it gets power). So
 * a board that connects is already showing something: the buffer starts from
 * what it reports, and only a mode that has something to show replaces it.
 */

import {defineStore} from 'pinia'
import {computed, nextTick, readonly, ref, shallowRef, watch} from 'vue'
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
	reofferSerialPort,
	requestSerialPort,
	type SerialFamily,
	serialPortLabel,
	serialRequestError,
} from '@/utils/serialDiscovery'

import {LED_FACES, type LedFace} from '../config'
import {readProjectBytes} from '../cuts'
import {LED_LAYOUT} from '../led/layout'
import {decodeWall, encodeWall, wallRecordPath} from '../led/wallRecord'
import type {ShotLedRecord} from '../projectData'

const FAMILY_ID = 'ws-fanout'

/** How often (ms) a wall that dropped off its port is looked for again. */
const RECONNECT_INTERVAL = 3000

/** `shownKey` while the live feed is on the wall. */
const LIVE_KEY = 'live'

function clamp255(v: number) {
	return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}

export type ChaseMode = 'pixel' | 'line'

/** What drives the wall. */
export type LedMode = 'off' | 'work' | 'live' | 'faces'
export const LED_MODES: readonly LedMode[] = ['off', 'work', 'live', 'faces']
export const LED_MODE_LABELS = ['Off', 'Work light', 'Live', 'Faces']
export const LED_MODE_ICONS = [
	'mdi:lightbulb-off-outline',
	'mdi:ceiling-light',
	'mdi:video-3d',
	'mdi:cube-outline',
]

export const useLedStore = defineStore('addsub:led', () => {
	const project = useProjectStore()

	const device = shallowRef<WsFanout | null>(null)
	const connecting = ref(false)
	const info = ref<DeviceInfo | null>(null)
	const lastShow = ref<ShowResult | null>(null)
	const lastError = ref<string | null>(null)
	const connected = computed(() => device.value !== null)

	/** The placement (led/layout.ts). */
	const layout = LED_LAYOUT

	//--------------------------------------------------------------------------
	// The wall buffer: what should be lit, per data line (layout line counts)

	function emptyWall() {
		return layout.lineCounts.map(n => new Uint8Array(n * 3))
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

	/**
	 * The port the wall is (or was last) on. When the wall drops off it while
	 * the port is still plugged in, `reconnect` asks there again.
	 */
	let lastPort: SerialPort | null = null

	function adopt(led: WsFanout) {
		lastPort = port(led)
		// The board lit the wall with the frame it kept: that is what is on the
		// wall now, whatever the buffer held while nothing was connected.
		if (led.restored) syncWallFromDevice(led)
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
		})
		// Apply the project's brightness cap; keep applying it when edited.
		void led.setBrightnessCap(project.addsub.led.brightnessCap).catch(() => {})
		checkLineCounts(led.cachedInfo)
	}

	function checkLineCounts(deviceInfo: DeviceInfo) {
		const expected = layout.lineCounts
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
		// Asked for: don't go looking for it again.
		lastPort = null
		await device.value?.disconnect()
	}

	// A wall that dropped off its port while the port is still plugged in (the
	// board reset or lost power and the port closed on it): keep asking on
	// that port until it answers. A replug needs none of this — the browser's
	// `connect` event starts a discovery.
	let reconnecting = false

	async function reconnect() {
		if (reconnecting || device.value || connecting.value) return
		if (!lastPort || !('serial' in navigator)) return
		reconnecting = true
		try {
			const granted = await navigator.serial
				.getPorts()
				.catch((): SerialPort[] => [])
			if (!device.value && lastPort && granted.includes(lastPort)) {
				await reofferSerialPort(family, lastPort)
			}
		} finally {
			reconnecting = false
		}
	}
	setInterval(() => void reconnect(), RECONNECT_INTERVAL)

	watch(
		() => project.addsub.led.brightnessCap,
		cap => {
			void device.value?.setBrightnessCap(cap).catch(() => {})
		}
	)

	//--------------------------------------------------------------------------
	// Output

	/**
	 * Put per-pixel colours on the wall and wait for the latch: one RGB buffer
	 * per data line in line order, or a single buffer of all lines
	 * concatenated (split by the layout's line counts). Short buffers leave
	 * the tail of a line untouched; long ones are truncated. Null when no
	 * device is connected (the preview is still updated). Used by the live
	 * feed from Houdini (§13.2) and by anything that already knows every
	 * pixel's colour.
	 */
	async function showColors(
		colors: Uint8Array | readonly Uint8Array[]
	): Promise<ShowResult | null> {
		covered = null
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
		return pushWall()
	}

	async function blackout() {
		await fill(0, 0, 0)
	}

	/** A manual fill: the mode drops to off and the fill stays until something else is shown. */
	async function fill(r: number, g: number, b: number) {
		covered = null
		shownKey = null
		mode.value = 'off'
		await fillAll(r, g, b)
	}

	async function fillAll(r: number, g: number, b: number) {
		fillWall(r, g, b)
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
		covered = null
		for (const face of LED_FACES) {
			const [r, g, b] = hexToRgb(project.addsub.led.faceColors[face] ?? '#ffffff')
			fillWall(r, g, b, linesOfFace(face))
		}
		return pushWall()
	}

	//--------------------------------------------------------------------------
	// Live feed: per-pixel colours pushed from outside (Houdini over the relay)

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
		if (mode.value !== 'live' || chasing.value) return
		if (livePending) liveDropped++
		livePending = rgb
		if (!liveShowing) void drainLive()
	}

	async function drainLive() {
		liveShowing = true
		try {
			while (livePending && mode.value === 'live') {
				const frame = livePending
				livePending = null
				await enqueue(async () => {
					await showColors(frame)
					shownKey = LIVE_KEY
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
	 * the wall is off while it runs; what it covered comes back after.
	 */
	async function startChase(opts: {mode?: ChaseMode; stepMs?: number; line?: number | null} = {}) {
		const led = device.value
		if (!led) throw new Error('LED wall is not connected')
		stopChase()
		covered ??= wall.value.map(buf => buf.slice())
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
	// Mode

	/**
	 * What drives the wall. `off` = nothing of koma's: the wall keeps what it
	 * shows (a fill, a recalled shot, the frame the board remembers). Set it
	 * with `setMode`; a fill or a recalled shot drops it to off by itself.
	 */
	const mode = ref<LedMode>('off')
	/** The mode the work light interrupted, for `leaveWorkLight`. */
	let modeBeforeWork: LedMode = 'off'

	/** Key of what's in the wall buffer, to skip redundant re-shows. */
	let shownKey: string | null = null
	/**
	 * The wall as it was before the work light or a chase took it over, put
	 * back when they end. Dropped by anything else that is shown meanwhile.
	 */
	let covered: Uint8Array[] | null = null
	let chain: Promise<unknown> = Promise.resolve()

	function enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const p = chain.then(fn, fn)
		chain = p.catch(() => {})
		return p
	}

	/**
	 * Wait until the wall shows what the current mode says: lets pending
	 * changes through, then sends the buffer once more for its latch. Null
	 * with no device. The sequence awaits this before capturing.
	 */
	async function ensureShown(): Promise<ShowResult | null> {
		await nextTick()
		return enqueue(() => pushWall())
	}

	/**
	 * Choose what drives the wall. Choosing `off` blacks the wall out (an
	 * explicit choice); choosing the work light remembers the mode it covers.
	 */
	function setMode(m: LedMode) {
		if (m === mode.value) return
		if (m === 'off') {
			void blackout().catch(() => {})
			return
		}
		if (m === 'work') modeBeforeWork = mode.value
		mode.value = m
	}

	/**
	 * End the work light (before a capture): the mode it interrupted comes
	 * back — faces or live re-show themselves, off puts back what the light
	 * covered. Nothing happens when it isn't on.
	 */
	function leaveWorkLight() {
		if (mode.value !== 'work') return
		mode.value = modeBeforeWork
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
	 * What a shot taken now should remember about its lighting: every pixel's
	 * RGB as sent (the device's own buffer), saved to the project folder.
	 * Nothing while the wall isn't connected. The pixels are copied before the
	 * first await, so call this at the exposure and await it later. Never
	 * rejects: a record that can't be written is logged and left out.
	 */
	async function recordForShot(): Promise<ShotLedRecord | undefined> {
		const led = device.value
		if (!led) return undefined
		const lines = Array.from({length: led.lineCount}, (_, i) => led.getLine(i).slice())
		const record: ShotLedRecord = {
			layoutVersion: layout.version,
			brightnessCap: project.addsub.led.brightnessCap,
		}
		try {
			record.wall = await saveWallRecord(lines)
		} catch (e) {
			// eslint-disable-next-line no-console
			console.error('[led] could not record the wall for this shot', e)
			return undefined
		}
		return record
	}

	/**
	 * Put a recorded wall (`shot.led.wall`) back, pixel for pixel — no gain —
	 * and wait for the latch. Lines are clipped to the current layout. Without
	 * a device only the preview buffer is updated.
	 */
	function showWallRecord(file: string): Promise<boolean> {
		covered = null
		mode.value = 'off'
		return enqueue(async () => {
			const root = project.directoryHandle
			if (!root) throw new Error('The project has no folder')
			const lines = decodeWall(await readProjectBytes(root, file))
			setWall(lines)
			await pushWall()
			shownKey = `wall|${file}`
			return true
		})
	}

	/** Put on the wall whatever the current mode says. */
	function applyState() {
		if (chasing.value) return
		if (mode.value === 'work') {
			if (shownKey === 'work') return
			covered ??= wall.value.map(buf => buf.slice())
			void enqueue(async () => {
				await fillAll(255, 255, 255)
				shownKey = 'work'
			}).catch(() => {})
			return
		}
		// The work light / chase is over: what it covered comes back, unless a
		// mode has its own to show.
		const restore = covered
		covered = null
		if (mode.value === 'live') {
			if (liveFrame.value) {
				if (shownKey !== LIVE_KEY) pushLiveFrame(liveFrame.value)
				return
			}
		} else if (mode.value === 'faces') {
			const key = `faces|${LED_FACES.map(f => project.addsub.led.faceColors[f]).join(',')}`
			if (shownKey === key) return
			void enqueue(async () => {
				await showFaces()
				shownKey = key
			}).catch(() => {})
			return
		}
		if (restore) {
			void enqueue(async () => {
				setWall(restore)
				shownKey = null
				await pushWall()
			}).catch(() => {})
		}
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
				mode.value,
				...LED_FACES.map(f => project.addsub.led.faceColors[f]),
			] as const,
		() => applyState(),
		{immediate: true}
	)

	/** Where the driver is plugged in ("#3 · CP210x 10c4:ea60"). */
	const portLabel = computed(() =>
		device.value ? serialPortLabel(port(device.value)) : null
	)

	return {
		device,
		connected,
		connecting: readonly(connecting),
		portLabel,
		info: readonly(info),
		lastShow: readonly(lastShow),
		lastError,
		wall: readonly(wall),
		wallVersion: readonly(wallVersion),
		layout,
		connect,
		disconnect,
		showColors,
		blackout,
		fill,
		ensureShown,
		mode: readonly(mode),
		setMode,
		leaveWorkLight,
		showFaces,
		liveFrame: readonly(liveFrame),
		liveInfo: readonly(liveInfo),
		pushLiveFrame,
		linesOfFace,
		chasing: readonly(chasing),
		startChase,
		stopChase,
		recordForShot,
		showWallRecord,
	}
})
