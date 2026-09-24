/**
 * LED wall (ws-fanout over Web Serial). ADDSUB.md §3.3, §8.
 *
 * Holds the connection, the placement map derived from the project's layout
 * params, and `showImage()` which samples an unwrapped lighting image into
 * the wall and resolves once the firmware has latched it (SHOW ack) — the
 * sequence waits on that before capturing.
 */

import {defineStore} from 'pinia'
import {computed, readonly, ref, shallowRef, watch} from 'vue'
import {
	CP210X_FILTER,
	type DeviceInfo,
	LINE_ALL,
	type PowerEstimate,
	type ShowResult,
	WebSerialTransport,
	WsFanout,
} from 'ws-fanout'

import {useProjectStore} from '@/stores/project'
import {
	discoverSerialPorts,
	registerSerialFamily,
	releaseSerialPort,
	requestSerialPortFor,
	type SerialFamily,
} from '@/utils/serialDiscovery'

import {BLOCK_HEIGHT} from '../config'
import {decodeImage} from '../led/decode'
import {buildLedLayout, ledLayoutFromSet} from '../led/layout'
import {type RgbaImage, sampleLedFrame} from '../led/sampler'
import {usePrevizStore} from './previz'

const FAMILY_ID = 'ws-fanout'

export const useLedStore = defineStore('addsub:led', () => {
	const project = useProjectStore()
	const previz = usePrevizStore()

	const device = shallowRef<WsFanout | null>(null)
	const connecting = ref(false)
	const info = ref<DeviceInfo | null>(null)
	const lastShow = ref<ShowResult | null>(null)
	const lastError = ref<string | null>(null)
	const power = ref<PowerEstimate | null>(null)
	/** Which lighting image is currently on the wall. */
	const shown = ref<{file: string; layoutVersion: number} | null>(null)

	const connected = computed(() => device.value !== null)

	/** The real placement from previz/set.json when present, else the fallback. */
	const layout = computed(() =>
		previz.setLed
			? ledLayoutFromSet(previz.setLed)
			: buildLedLayout(project.addsub.led.layout, project.addsub.led.layoutVersion)
	)

	/** world Y = film Y + lift, for the current base block. */
	const lift = computed(
		() => BLOCK_HEIGHT * project.addsub.kBase + project.addsub.calibration.filmOriginWorld[1]
	)

	//--------------------------------------------------------------------------
	// Connection

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
		wants: () => device.value === null,
		probe,
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

	// The transport isn't exposed; track ports ourselves for release.
	const ports = new WeakMap<WsFanout, SerialPort>()
	function port(led: WsFanout): SerialPort {
		return ports.get(led) as SerialPort
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
			const result = await requestSerialPortFor(family, {filters: [CP210X_FILTER]})
			if (result === 'rejected') lastError.value = 'No ws-fanout device answered on that port'
			else if (result === 'owned') lastError.value = 'That port is already in use by another device'
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

	function requireDevice() {
		const d = device.value
		if (!d) throw new Error('LED wall is not connected')
		return d
	}

	/** Sample `image` (film coordinates) into the wall and wait for the latch. */
	async function showImage(
		image: RgbaImage,
		ref_: {file: string} | null = null
	): Promise<ShowResult> {
		const led = requireDevice()
		const lines = sampleLedFrame(layout.value, image, {
			topFilmY: project.addsub.led.topFilmY,
			lift: lift.value,
			gain: project.addsub.led.gain,
		})
		lines.forEach((rgb, i) => {
			if (i < led.lineCount) led.setLine(i, rgb)
		})
		power.value = led.estimatePower()
		try {
			const result = await led.show()
			shown.value = ref_ ? {file: ref_.file, layoutVersion: layout.value.version} : null
			lastError.value = null
			return result
		} catch (e) {
			lastError.value = e instanceof Error ? e.message : String(e)
			throw e
		}
	}

	async function showImageBlob(blob: Blob, ref_: {file: string} | null = null) {
		const image = await decodeImage(blob)
		return showImage(image, ref_)
	}

	async function blackout() {
		const led = requireDevice()
		await led.fill(LINE_ALL, 0, 0, 0)
		shown.value = null
		power.value = led.estimatePower()
	}

	async function fill(r: number, g: number, b: number) {
		const led = requireDevice()
		await led.fill(LINE_ALL, r, g, b)
		shown.value = null
		power.value = led.estimatePower()
	}

	//--------------------------------------------------------------------------
	// Follow the capture frame (ADDSUB.md: 撮影コマに移ったら自動的にその照明) with
	// a temporary all-white work light on top.

	/** Show each capture frame's lighting automatically. */
	const followCapture = ref(true)
	/** Temporary all-white for working on the set; restores the frame after. */
	const workLight = ref(false)

	/** Key of what's on the wall, to skip redundant re-shows. */
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
		return enqueue(async () => {
			const pf = previz.frameFor(frame)
			if (!pf?.led || !device.value) return false
			const key = frameKey(pf.led)
			if (!opts.force && shownKey === key && !workLight.value) return true
			const blob = await previz.readBlob(pf.led)
			await showImageBlob(blob, {file: pf.led})
			shownKey = key
			return true
		})
	}

	function setWorkLight(on: boolean) {
		workLight.value = on
	}

	// Any of these changing re-evaluates what should be on the wall.
	watch(
		() =>
			[
				connected.value,
				workLight.value,
				followCapture.value,
				project.captureShot.frame,
				lift.value,
				project.addsub.led.gain,
				project.addsub.led.topFilmY,
				previz.lastModified,
			] as const,
		([isConnected, work, follow, frame]) => {
			if (!isConnected) {
				shownKey = null
				return
			}
			if (work) {
				void enqueue(async () => {
					await fill(255, 255, 255)
					shownKey = 'work'
				}).catch(() => {})
				return
			}
			if (follow) void ensureFrame(frame).catch(() => {})
		},
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
		power: readonly(power),
		shown: readonly(shown),
		layout,
		lift,
		connect,
		disconnect,
		showImage,
		showImageBlob,
		blackout,
		fill,
		followCapture,
		workLight,
		setWorkLight,
		ensureFrame,
	}
})
