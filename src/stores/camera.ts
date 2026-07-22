import {useTethr} from '@tethr/vue3'
import {defineStore} from 'pinia'
import {Tethr, TethrDeviceType, TethrIdentifier} from 'tethr'
import {ref, watch} from 'vue'

import {useProjectStore} from './project'

// TEMP DEBUG: liveview stall probe — with a camera connected and LV running,
// call `lvProbe()` (optionally `lvProbe(seconds)`) in the console. Records every
// PTP transaction (label + duration) and main-thread long tasks for the given
// window, then prints fps, per-label stats, the worst inter-frame gaps with
// whatever else ran inside them, and the long-task list.
;(window as any).lvProbe = async function lvProbe(seconds = 10) {
	/* eslint-disable no-console */
	const dev = (window as any).cam?.device
	if (!dev) return console.log('no camera (window.cam is unset)')

	interface Tx {
		l: string
		s: number
		d: number
		/** PTP response code (0x2001 = OK, 0x2019 = DeviceBusy), -1 = threw. */
		rc: number
	}
	const events: Tx[] = []
	const longtasks: number[][] = []
	const t0 = performance.now()

	const po = new PerformanceObserver(list => {
		for (const e of list.getEntries()) {
			longtasks.push([Math.round(e.startTime - t0), Math.round(e.duration)])
		}
	})
	po.observe({entryTypes: ['longtask']})

	const orig = dev.receiveData
	dev.receiveData = (opt: any) => {
		const s = performance.now() - t0
		const push = (rc: number) =>
			events.push({
				l: opt.label ?? 'unknown',
				s: Math.round(s),
				d: Math.round(performance.now() - t0 - s),
				rc,
			})
		return orig(opt).then(
			(r: any) => {
				push(r?.resCode ?? 0)
				return r
			},
			(err: unknown) => {
				push(-1)
				throw err
			}
		)
	}

	await new Promise(resolve => setTimeout(resolve, seconds * 1000))

	dev.receiveData = orig
	po.disconnect()

	const isLV = (e: Tx) => /GetViewFrame|GetViewFinderData/.test(e.l)
	// Only OK responses delivered a frame; busy answers are just polling misses.
	const lv = events.filter(e => isLV(e) && e.rc === 0x2001)
	const lvBusy = events.filter(e => isLV(e) && e.rc !== 0x2001)

	const gaps: {at: number; gap: number}[] = []
	for (let i = 1; i < lv.length; i++) {
		const prevEnd = lv[i - 1].s + lv[i - 1].d
		gaps.push({at: prevEnd, gap: lv[i].s + lv[i].d - prevEnd})
	}
	gaps.sort((a, b) => b.gap - a.gap)

	const worst = gaps.slice(0, 8).map(w => ({
		...w,
		others: events
			.filter(e => !isLV(e) && e.s >= w.at - 5 && e.s <= w.at + w.gap + 5)
			.map(e => `${e.l}:${e.d}ms`),
	}))

	// Per-label × per-resCode stats, so busy answers don't blur delivery costs.
	const stats: Record<string, {n: number; avg: number; max: number}> = {}
	for (const e of events) {
		const key = e.l + (e.rc === 0x2001 ? '' : `[${e.rc.toString(16)}]`)
		const s = (stats[key] ??= {n: 0, avg: 0, max: 0})
		s.n++
		s.avg += e.d
		if (e.d > s.max) s.max = e.d
	}
	for (const k of Object.keys(stats)) {
		stats[k].avg = Math.round(stats[k].avg / stats[k].n)
	}

	console.log(
		`LV delivered: ${lv.length} = ${(lv.length / seconds).toFixed(1)} fps, ` +
			`busy misses: ${lvBusy.length}`
	)
	console.log('stats: ' + JSON.stringify(stats))
	console.log('worstGaps: ' + JSON.stringify(worst))
	console.log('longtasks: ' + JSON.stringify(longtasks.slice(0, 20)))
	/* eslint-enable no-console */
}

// TEMP DEBUG: Sigma GetCamStatus2 cost probe — times the status query at a
// given request mask, 20 samples at the poller's own 250 ms cadence, LV
// running. Compare `sigmaStatusProbe()` (the full query the poller sends
// today: all 7 groups + CanSetInfo5) against `sigmaStatusProbe(0, 0b0100001)`
// (just group1 + focus — all the LV-time poll actually reads) to see whether
// the periodic 200-250 ms responses are the cost of CanSetInfo5 regeneration.
;(window as any).sigmaStatusProbe = async function sigmaStatusProbe(
	p1 = 0b10000,
	p2 = 0b1111111,
	n = 20
) {
	/* eslint-disable no-console */
	const dev = (window as any).cam?.device
	if (!dev) return console.log('no camera (window.cam is unset)')

	const times: number[] = []
	for (let i = 0; i < n; i++) {
		const s = performance.now()
		await dev.receiveData({
			label: 'SigmaFP StatusProbe',
			opcode: 0x902c,
			parameters: [p1, p2, 0],
			expectedResCodes: [0x2001, 0x2019],
		})
		times.push(Math.round(performance.now() - s))
		await new Promise(resolve => setTimeout(resolve, 250))
	}
	const max = Math.max(...times)
	const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length)
	console.log(
		`p1=0b${p1.toString(2)} p2=0b${p2.toString(2)} avg=${avg} max=${max}: ` +
			JSON.stringify(times)
	)
	/* eslint-enable no-console */
}

export const useCameraStore = defineStore('camera', () => {
	const project = useProjectStore()

	// @tethr/vue3 now owns device matching (requestCamera accepts an identifier)
	// and exposes `isConnecting`, so the app no longer reaches into USB internals
	// or guards the auto-reconnect race itself.
	const {
		pairedCameras,
		requestCamera,
		isConnecting,
		close,
		camera: tethr,
		toggleLiveview,
		runManualFocus,
		setLiveviewMagnifyPos,
		configs,
	} = useTethr()

	// Auto-reconnect to the project's remembered camera when it's available and
	// nothing is connected. Re-runs when the project (its `camera` identity)
	// changes or a device is plugged in. `prompt: false` keeps it silent — this
	// isn't a user gesture, so a picker would throw anyway.
	watch(
		() => [project.camera, pairedCameras.value] as const,
		() => {
			if (project.camera) connect(project.camera, {prompt: false})
		},
		{immediate: true}
	)

	async function connect(
		query: TethrDeviceType | TethrIdentifier,
		opts?: {prompt?: boolean}
	) {
		if (tethr.value || isConnecting.value) return
		await requestCamera(query, opts)
		if (tethr.value) await setupCamera(tethr.value)
	}

	async function setupCamera(cam: Tethr) {
		cam.setLog(false)

		const model = await cam.getModel()

		// Remember this exact camera so we can reconnect to it next time.
		project.camera = {...cam.identifier, model: model ?? undefined}

		// importConfigs() now verifies and retries each write itself (see
		// TethrSigma), so the old "set white balance again after a delay"
		// workaround is no longer needed.
		await cam.importConfigs(project.cameraConfigs)

		saveConfigs()

		async function saveConfigs() {
			project.cameraConfigs = {
				model: model ?? undefined,
				...(await cam.exportConfigs()),
			}
		}

		cam.on('change', saveConfigs)
		;(window as any).cam = cam

		await cam.startLiveview()
	}

	/** Connect to a specific already-paired camera, switching if needed. */
	async function connectCamera(cam: Tethr) {
		if (isConnecting.value || tethr.value === cam) return
		if (tethr.value) await close()
		await connect(cam.identifier, {prompt: false})
	}

	function disconnect() {
		return close()
	}

	/** Prompt to grant/select a new device of the given type and connect to it. */
	async function grant(type: TethrDeviceType) {
		if (isConnecting.value) return
		if (tethr.value) await close()
		await connect(type)
	}

	// Bumped to ask the title-bar connection popup to open (and flash for
	// attention) — e.g. from the "Connect to Camera" button shown in Camera
	// Control while disconnected. A nonce so repeated requests each re-trigger.
	const connectPromptNonce = ref(0)

	function promptConnect() {
		connectPromptNonce.value++
	}

	return {
		tethr,
		pairedCameras,
		isConnecting,
		connectCamera,
		disconnect,
		grant,
		toggleLiveview,
		runManualFocus,
		setLiveviewMagnifyPos,
		connectPromptNonce,
		promptConnect,

		// All camera configs from @tethr/vue3
		...configs,
	}
})
