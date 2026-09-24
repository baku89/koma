/**
 * The per-frame shooting sequence (ADDSUB.md §2), as a resumable step machine:
 *
 *   cut → spindleOff → extend → rig → led → settle → capture → park → retract
 *
 * Every step waits for its device to confirm completion (FluidNC Idle, LED
 * SHOW ack, capture resolved) before the next starts. Progress is written to
 * `project.addsub.sequence` after each step so a stop, an error, a crash or a
 * reload leaves enough to resume from the right step — this is what a helper
 * uses when the artist isn't around (§1 運用条件).
 *
 * Stopping: `stop()` aborts the current wait, feed-holds both machines and
 * marks the progress `stopped`. It does not reset anything, so `resume()` can
 * continue (after the operator clears the hold / alarm).
 */

import {defineStore} from 'pinia'
import {computed, readonly, ref} from 'vue'

import {useProjectStore} from '@/stores/project'
import {
	type AxesPosition,
	FluidNCError,
	prepareGCode,
	setWorkOffsetLine,
} from '@/utils/fluidnc'

import {BLOCK_HEIGHT} from '../config'
import {filmOriginMill} from '../coords'
import {cameraPoseToRigAxes, type RigTarget} from '../kinematics'
import {
	SEQUENCE_STEPS,
	type SequenceProgress,
	type SequenceStep,
} from '../projectData'
import {useLedStore} from './led'
import {useMillStore, useRigStore} from './machines'
import {usePrevizStore} from './previz'

export interface CaptureRequest {
	/** Timeline frame being shot. */
	frame: number
	layer: number
	kind: 'main' | 'park'
	previzFrame: number
	cameraConfigs?: Record<string, unknown>
}

export type CaptureHandler = (req: CaptureRequest) => Promise<void>

export class SequenceError extends Error {
	constructor(
		public readonly step: SequenceStep,
		message: string
	) {
		super(message)
		this.name = 'SequenceError'
	}
}

export const useSequenceStore = defineStore('addsub:sequence', () => {
	const project = useProjectStore()
	const mill = useMillStore()
	const rig = useRigStore()
	const led = useLedStore()
	const previz = usePrevizStore()

	const running = ref(false)
	/** Continuous mode: keep going to the next frame after each one. */
	const continuous = ref(false)
	const stopRequested = ref(false)
	const currentStep = ref<SequenceStep | null>(null)
	const message = ref<string | null>(null)
	const warnings = ref<string[]>([])

	let abort: AbortController | null = null
	let capture: CaptureHandler | null = null

	const progress = computed(() => project.addsub.sequence)

	/** Provided by the app (it owns the camera / timeline plumbing). */
	function registerCapture(handler: CaptureHandler | null) {
		capture = handler
	}

	//--------------------------------------------------------------------------
	// Progress bookkeeping

	function setProgress(p: SequenceProgress) {
		project.addsub.sequence = p
	}

	function patchProgress(patch: Partial<SequenceProgress>) {
		const cur = project.addsub.sequence
		if (!cur) return
		project.addsub.sequence = {...cur, ...patch, updatedAt: Date.now()}
	}

	function markDone(step: SequenceStep) {
		const cur = project.addsub.sequence
		if (!cur) return
		const next = SEQUENCE_STEPS[SEQUENCE_STEPS.indexOf(step) + 1]
		patchProgress({
			done: cur.done.includes(step) ? cur.done : [...cur.done, step],
			step: next ?? step,
		})
	}

	function clearProgress() {
		project.addsub.sequence = null
	}

	//--------------------------------------------------------------------------
	// Steps

	function signal(): AbortSignal {
		if (!abort) throw new Error('not running')
		return abort.signal
	}

	function checkStop(step: SequenceStep) {
		if (stopRequested.value || abort?.signal.aborted) {
			throw new SequenceError(step, 'Stopped')
		}
	}

	function rigLimitsCheck(target: RigTarget) {
		const limits = project.addsub.rigLimits
		for (const [axis, range] of Object.entries(limits)) {
			if (!range) continue
			const v = target[axis as keyof RigTarget]
			if (v < range[0] || v > range[1]) {
				throw new SequenceError(
					'rig',
					`Rig ${axis.toUpperCase()} = ${v.toFixed(3)} is outside [${range[0]}, ${range[1]}]`
				)
			}
		}
	}

	function warn(text: string) {
		warnings.value = [...warnings.value.slice(-19), text]
	}

	async function stepCut(frame: number) {
		const pf = previz.frameFor(frame)
		if (!pf?.gcode) {
			warn(`Frame ${frame}: no G-code — skipping cut`)
			return
		}
		if (!mill.connected) throw new SequenceError('cut', 'Mill is not connected')
		let text: string
		try {
			text = await previz.readText(pf.gcode)
		} catch {
			throw new SequenceError('cut', `G-code file missing: ${pf.gcode}`)
		}
		const lines = prepareGCode(text).map(l => l.line)
		if (lines.length === 0) {
			warn(`Frame ${frame}: empty G-code — skipping cut`)
			return
		}
		// Point G54 at the film origin for the current base block (§7.1).
		const {calibration, kBase} = project.addsub
		const origin = filmOriginMill(kBase, calibration.filmOriginWorld, calibration.millOffset)
		await mill.send(setWorkOffsetLine(1, {x: origin[0], y: origin[1], z: origin[2]}))
		message.value = `Cutting frame ${frame} (${lines.length} lines)`
		await mill.stream(lines, {signal: signal()})
		await mill.waitIdle({signal: signal()})
	}

	async function stepSpindleOff() {
		if (!mill.connected) return
		const acc = mill.status?.accessories ?? ''
		if (acc.includes('S') || acc.includes('C')) {
			await mill.send('M5')
		}
		const z = mill.mpos.z
		const safeZ = project.addsub.millSafeZ
		if (z !== undefined && z < safeZ) {
			message.value = `Retracting head to Z${safeZ}`
			await mill.moveTo({z: safeZ}, {signal: signal()})
		}
		await mill.waitIdle({signal: signal(), settle: 1})
	}

	async function stepExtend() {
		if (!mill.connected) throw new SequenceError('extend', 'Mill is not connected')
		const {shootPosition, cutPosition, millFeed} = project.addsub
		const cur = mill.mpos
		if (!project.addsub.sequence?.returnPosition) {
			patchProgress({
				returnPosition: cutPosition ?? {
					x: cur.x ?? shootPosition.x,
					y: shootPosition.y !== undefined ? cur.y : undefined,
				},
			})
		}
		const target: AxesPosition = {x: shootPosition.x}
		if (shootPosition.y !== undefined) target.y = shootPosition.y
		message.value = 'Extending table to the shoot position'
		await mill.moveTo(target, {feed: millFeed, signal: signal()})
	}

	async function stepRig(frame: number) {
		const pf = previz.frameFor(frame)
		if (!pf?.pose) throw new SequenceError('rig', `Frame ${frame}: no camera pose in previz`)
		if (!rig.connected) throw new SequenceError('rig', 'Box Rig is not connected')
		const {calibration, kBase, rigFeed} = project.addsub
		const target = cameraPoseToRigAxes(pf.pose, kBase, calibration)
		rigLimitsCheck(target)
		message.value = `Moving rig to frame ${frame}`
		await rig.moveTo(target, {feed: rigFeed, signal: signal()})
	}

	async function stepLed(frame: number) {
		const pf = previz.frameFor(frame)
		if (!pf?.led) {
			warn(`Frame ${frame}: no LED image`)
			return
		}
		if (!led.connected) {
			if (project.addsub.ledOptional) {
				warn('LED wall not connected — skipped')
				return
			}
			throw new SequenceError('led', 'LED wall is not connected')
		}
		let blob: Blob
		try {
			blob = await previz.readBlob(pf.led)
		} catch {
			if (project.addsub.ledOptional) {
				warn(`LED image missing: ${pf.led}`)
				return
			}
			throw new SequenceError('led', `LED image missing: ${pf.led}`)
		}
		message.value = `Lighting frame ${frame}`
		await led.showImageBlob(blob, {file: pf.led})
	}

	async function stepSettle() {
		const ms = project.addsub.settleMs
		message.value = `Settling ${ms} ms`
		await new Promise<void>((resolve, reject) => {
			const t = setTimeout(resolve, ms)
			signal().addEventListener(
				'abort',
				() => {
					clearTimeout(t)
					reject(new SequenceError('settle', 'Stopped'))
				},
				{once: true}
			)
		})
	}

	async function stepCapture(frame: number, kind: 'main' | 'park') {
		if (!capture) throw new SequenceError('capture', 'No capture handler registered')
		const pf = previz.frameFor(frame)
		message.value = kind === 'park' ? 'Park reference shot' : `Capturing frame ${frame}`
		await capture({
			frame,
			layer: kind === 'park' ? project.addsub.parkLayer : 0,
			kind,
			previzFrame: frame + project.addsub.previzFrameOffset,
			cameraConfigs: pf?.cameraConfigs,
		})
	}

	async function stepPark(frame: number) {
		const {parkPose, takeParkShot, rigFeed} = project.addsub
		if (!takeParkShot || !parkPose) return
		if (!rig.connected) throw new SequenceError('park', 'Box Rig is not connected')
		message.value = 'Moving rig to park'
		await rig.moveTo(parkPose, {feed: rigFeed, signal: signal()})
		await stepSettle()
		await stepCapture(frame, 'park')
	}

	async function stepRetract() {
		if (!mill.connected) throw new SequenceError('retract', 'Mill is not connected')
		const back = project.addsub.sequence?.returnPosition ?? project.addsub.cutPosition
		if (!back) {
			warn('No return position recorded — table left at the shoot position')
			return
		}
		const target: AxesPosition = {x: back.x}
		if (back.y !== undefined) target.y = back.y
		message.value = 'Returning table'
		await mill.moveTo(target, {feed: project.addsub.millFeed, signal: signal()})
	}

	async function runStep(step: SequenceStep, frame: number) {
		checkStop(step)
		currentStep.value = step
		patchProgress({step, status: 'running'})
		switch (step) {
			case 'cut':
				return stepCut(frame)
			case 'spindleOff':
				return stepSpindleOff()
			case 'extend':
				return stepExtend()
			case 'rig':
				return stepRig(frame)
			case 'led':
				return stepLed(frame)
			case 'settle':
				return stepSettle()
			case 'capture':
				return stepCapture(frame, 'main')
			case 'park':
				return stepPark(frame)
			case 'retract':
				return stepRetract()
		}
	}

	//--------------------------------------------------------------------------
	// Driving

	/**
	 * Run one frame from `fromStep` (default: the first step, or where the
	 * saved progress for that frame left off). Resolves when the frame is done.
	 */
	async function runFrame(frame: number, fromStep?: SequenceStep) {
		const saved = project.addsub.sequence
		const resume = saved && saved.frame === frame && saved.status !== 'done'
		const done = resume ? saved.done : []
		const start = fromStep ?? (resume ? saved.step : SEQUENCE_STEPS[0])

		setProgress({
			frame,
			step: start,
			done: fromStep ? done.filter(s => SEQUENCE_STEPS.indexOf(s) < SEQUENCE_STEPS.indexOf(fromStep)) : done,
			status: 'running',
			returnPosition: resume ? saved.returnPosition : undefined,
			updatedAt: Date.now(),
		})

		const startIndex = SEQUENCE_STEPS.indexOf(start)
		for (const step of SEQUENCE_STEPS.slice(startIndex)) {
			if (project.addsub.sequence?.done.includes(step)) continue
			await runStep(step, frame)
			markDone(step)
		}
		patchProgress({status: 'done', step: SEQUENCE_STEPS[SEQUENCE_STEPS.length - 1]})
		currentStep.value = null
	}

	/**
	 * Start at `frame` (default: the capture frame, resuming saved progress if
	 * it is for that frame). With `continuous`, keep shooting following frames
	 * until `stop()`, the previz runs out, or an error.
	 */
	async function start(opts: {frame?: number; fromStep?: SequenceStep; continuous?: boolean} = {}) {
		if (running.value) return
		running.value = true
		continuous.value = opts.continuous ?? false
		stopRequested.value = false
		abort = new AbortController()
		warnings.value = []
		message.value = null

		let frame = opts.frame ?? project.captureShot.frame
		let fromStep = opts.fromStep

		try {
			for (;;) {
				await runFrame(frame, fromStep)
				fromStep = undefined
				if (!continuous.value || stopRequested.value) break
				frame = project.captureShot.frame
				if (!previz.frameFor(frame)) {
					message.value = `No previz data for frame ${frame} — stopped`
					break
				}
			}
			message.value = continuous.value ? 'Stopped' : 'Done'
		} catch (e) {
			const step = e instanceof SequenceError ? e.step : currentStep.value
			const text = e instanceof Error ? e.message : String(e)
			const stopped =
				stopRequested.value ||
				(e instanceof FluidNCError && e.kind === 'aborted') ||
				(e instanceof SequenceError && e.message === 'Stopped')
			patchProgress({
				status: stopped ? 'stopped' : 'error',
				error: stopped ? undefined : text,
				step: step ?? project.addsub.sequence?.step ?? SEQUENCE_STEPS[0],
			})
			message.value = stopped ? 'Stopped' : `Error at ${step}: ${text}`
			if (!stopped) {
				// eslint-disable-next-line no-console
				console.error('[sequence]', e)
			}
		} finally {
			running.value = false
			currentStep.value = null
			abort = null
		}
	}

	/** Finish the current frame, then don't continue. */
	function pauseAfterFrame() {
		continuous.value = false
	}

	/**
	 * Stop now: abort the current wait and feed-hold both machines. The
	 * operator clears the hold (resume / reset) from the machine panels.
	 */
	async function stop() {
		if (!running.value) return
		stopRequested.value = true
		abort?.abort()
		await Promise.allSettled([
			mill.connected ? mill.feedHold() : Promise.resolve(),
			rig.connected ? rig.feedHold() : Promise.resolve(),
		])
	}

	/** Resume the saved progress (same frame, from the step it stopped at). */
	function resume(fromStep?: SequenceStep) {
		const p = project.addsub.sequence
		if (!p) return start()
		return start({frame: p.frame, fromStep: fromStep ?? p.step})
	}

	//--------------------------------------------------------------------------
	// Block append helpers (§7)

	/** Remaining height of the top block: for the operator display. */
	const stackHeight = computed(() => {
		// The mill can hold two blocks (100 mm limit); we only know the stack
		// from k_base, so report the nominal top of the current stack.
		return BLOCK_HEIGHT * 2
	})

	function appendBlock() {
		project.addsub.kBase += 1
	}

	return {
		running: readonly(running),
		continuous: readonly(continuous),
		currentStep: readonly(currentStep),
		message: readonly(message),
		warnings: readonly(warnings),
		progress,
		stackHeight,
		registerCapture,
		start,
		resume,
		stop,
		pauseAfterFrame,
		clearProgress,
		appendBlock,
		steps: SEQUENCE_STEPS,
	}
})
