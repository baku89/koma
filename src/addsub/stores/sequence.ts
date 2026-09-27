/**
 * The per-frame shooting sequence (ADDSUB.md §2), as a resumable step machine:
 *
 *   cut → extend → (rig ∥ led) → settle → capture → park → retract
 *
 * (Spindle stop and head retract are part of the CAM-generated G-code, so
 * they belong to `cut`, not to a step of their own. `rig` and `led` talk to
 * different devices and run concurrently.)
 *
 * Replay mode (§7.2, after appending a block): rig ∥ led → settle → capture,
 * driven by what each *recorded* shot has (rig axes lifted by the k_base
 * difference, its LED image re-sampled at the new lift, its exposure) into a
 * "replay" layer, one per pass.
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
import {cameraPoseToRigAxes} from '../kinematics'
import {type FramePlan, planFor as planForFrame, setPlan as setPlanFrame} from '../plan'
import {
	REPLAY_STEPS,
	SEQUENCE_STEPS,
	type SequenceMode,
	type SequenceProgress,
	type SequenceStep,
} from '../projectData'
import {useLedStore} from './led'
import {useMillStore, useRigStore} from './machines'
import {PREVIZ_DIR, usePrevizStore} from './previz'

export interface CaptureRequest {
	/** Timeline frame being shot. */
	frame: number
	layer: number
	kind: 'main' | 'park' | 'replay'
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
	/**
	 * The G-code being streamed to the mill right now (path relative to the
	 * project folder), for the screens' "current line" display. Null between
	 * cuts.
	 */
	const cutting = ref<{frame: number; path: string} | null>(null)

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

	function stepsFor(mode: SequenceMode | undefined): readonly SequenceStep[] {
		return mode === 'replay' ? REPLAY_STEPS : SEQUENCE_STEPS
	}

	function markDone(step: SequenceStep) {
		const cur = project.addsub.sequence
		if (!cur) return
		const steps = stepsFor(cur.mode)
		const done = cur.done.includes(step) ? cur.done : [...cur.done, step]
		const next = steps.find(s => !done.includes(s))
		patchProgress({done, step: next ?? step})
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

	function rigLimitsCheck(target: AxesPosition) {
		const limits = project.addsub.rigLimits
		for (const [axis, range] of Object.entries(limits)) {
			if (!range) continue
			const v = target[axis as keyof AxesPosition]
			if (v === undefined) continue
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

	//--------------------------------------------------------------------------
	// What to do for a frame, per mode

	interface FrameSource {
		/** Partial: axes left out are not moved. */
		rigTarget: AxesPosition | null
		ledFile: string | null
		cameraConfigs?: Record<string, unknown>
		/** Timeline frame whose lighting `led.ensureFrame` should show. */
		ledFrame: number
	}

	function resolveSource(frame: number, mode: SequenceMode): FrameSource {
		const {calibration, kBase} = project.addsub
		if (mode === 'replay') {
			const src = project.shot(frame, 0)
			if (!src?.rig || src.rig.x === undefined) {
				return {rigTarget: null, ledFile: null, ledFrame: frame}
			}
			const dk = kBase - (src.kBase ?? 0)
			const r = src.rig
			return {
				rigTarget: {
					x: r.x ?? 0,
					y: (r.y ?? 0) + BLOCK_HEIGHT * dk,
					z: r.z ?? 0,
					a: r.a ?? 0,
					b: r.b ?? 0,
					c: r.c ?? 0,
				},
				ledFile: src.led?.file ?? null,
				cameraConfigs: src.cameraConfigs as Record<string, unknown> | undefined,
				ledFrame: frame,
			}
		}
		// The koma-side plan for this frame (plan.ts) overrides previz field by
		// field: explicit rig axes first, else a camera pose to solve, else previz.
		const pf = previz.frameFor(frame)
		const plan = planFor(frame)
		const rigTarget = plan?.rig
			? {...plan.rig}
			: plan?.camera
				? cameraPoseToRigAxes(plan.camera, kBase, calibration)
				: pf?.pose
					? cameraPoseToRigAxes(pf.pose, kBase, calibration)
					: null
		return {
			rigTarget,
			ledFile: pf?.led ?? null,
			cameraConfigs: (plan?.cameraConfigs ?? pf?.cameraConfigs) as
				| Record<string, unknown>
				| undefined,
			ledFrame: frame,
		}
	}

	//--------------------------------------------------------------------------
	// Plans (plan.ts): per layer + frame, on the capture layer unless given

	function planFor(frame: number, layer = project.captureShot.layer): FramePlan | undefined {
		return planForFrame(project, frame, layer)
	}

	function setPlan(frame: number, plan: FramePlan | null, layer = project.captureShot.layer) {
		setPlanFrame(project, frame, layer, plan)
	}

	/** Whether the sequence has anything to shoot at this frame. */
	function hasSource(frame: number, layer = project.captureShot.layer) {
		return !!planFor(frame, layer) || !!previz.frameFor(frame)
	}

	/**
	 * Move the rig to the frame's planned pose, now. This is the only way a
	 * plan moves the rig outside the sequence: seeking never does. Same checks
	 * as the sequence's rig step.
	 */
	async function goToPlan(frame = project.captureShot.frame, layer = project.captureShot.layer) {
		if (running.value) throw new SequenceError('rig', 'Sequence is running')
		const plan = planFor(frame, layer)
		if (!plan) throw new SequenceError('rig', `Frame ${frame}: no plan`)
		const {calibration, kBase} = project.addsub
		const target = plan.rig
			? {...plan.rig}
			: plan.camera
				? cameraPoseToRigAxes(plan.camera, kBase, calibration)
				: null
		if (!target) throw new SequenceError('rig', `Frame ${frame}: plan has no pose`)
		if (!rig.connected) throw new SequenceError('rig', 'Box Rig is not connected')
		rigLimitsCheck(target)
		message.value = `Moving rig to plan for frame ${frame}`
		try {
			await rig.moveTo(target, {feed: project.addsub.rigFeed})
			message.value = null
		} catch (e) {
			message.value = e instanceof Error ? e.message : String(e)
			throw e
		}
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
		cutting.value = {frame, path: `${PREVIZ_DIR}/${pf.gcode}`}
		try {
			await mill.stream(lines, {signal: signal()})
			await mill.waitIdle({signal: signal()})
		} finally {
			cutting.value = null
		}
	}

	/**
	 * Whether the mill has to take part in this frame. A frame with no G-code
	 * (a rig-only plan, a `cut: false` previz frame) can be shot with the mill
	 * offline: the table then simply stays where the operator left it.
	 */
	function millNeeded(frame: number) {
		return !!previz.frameFor(frame)?.gcode
	}

	async function stepExtend(frame: number) {
		if (!mill.connected) {
			if (millNeeded(frame)) throw new SequenceError('extend', 'Mill is not connected')
			warn('Mill not connected — table not moved')
			return
		}
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

	async function stepRig(frame: number, src: FrameSource) {
		if (!src.rigTarget) {
			throw new SequenceError('rig', `Frame ${frame}: no camera pose`)
		}
		if (!rig.connected) throw new SequenceError('rig', 'Box Rig is not connected')
		rigLimitsCheck(src.rigTarget)
		message.value = `Moving rig to frame ${frame}`
		await rig.moveTo(src.rigTarget, {feed: project.addsub.rigFeed, signal: signal()})
	}

	async function stepLed(frame: number, src: FrameSource, mode: SequenceMode) {
		if (!src.ledFile) {
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
		led.setWorkLight(false)
		try {
			if (mode === 'replay') {
				const blob = await previz.readBlob(src.ledFile)
				await led.showImageBlob(blob, {file: src.ledFile})
			} else {
				// Usually already on the wall (the store follows the capture
				// frame); this just waits for the latch.
				await led.ensureFrame(src.ledFrame)
			}
		} catch (e) {
			if (project.addsub.ledOptional) {
				warn(`LED: ${e instanceof Error ? e.message : String(e)}`)
				return
			}
			throw new SequenceError('led', e instanceof Error ? e.message : String(e))
		}
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

	function layerFor(kind: 'main' | 'park' | 'replay'): number {
		switch (kind) {
			case 'main':
				// Whatever layer the capture slot is on: the film (0) or a named
				// test shot started from any frame.
				return project.captureShot.layer
			case 'park': {
				const id = project.addsub.parkLayerId
				const idx = id ? project.layerIndexOf(id) : -1
				if (idx !== -1) return idx
				const created = project.addLayer('Park')
				project.addsub.parkLayerId = project.layers[created].id
				return created
			}
			case 'replay': {
				const id = project.addsub.sequence?.replayLayerId
				const idx = id ? project.layerIndexOf(id) : -1
				if (idx !== -1) return idx
				const created = project.addLayer(`Replay k${project.addsub.kBase}`)
				patchProgress({replayLayerId: project.layers[created].id})
				return created
			}
		}
	}

	async function stepCapture(
		frame: number,
		kind: 'main' | 'park' | 'replay',
		src?: FrameSource
	) {
		if (!capture) throw new SequenceError('capture', 'No capture handler registered')
		message.value =
			kind === 'park'
				? 'Park reference shot'
				: kind === 'replay'
					? `Re-shooting frame ${frame}`
					: `Capturing frame ${frame}`
		await capture({
			frame,
			layer: layerFor(kind),
			kind,
			previzFrame: frame + project.addsub.previzFrameOffset,
			cameraConfigs: src?.cameraConfigs,
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

	async function stepRetract(frame: number) {
		if (!mill.connected) {
			if (millNeeded(frame)) throw new SequenceError('retract', 'Mill is not connected')
			return
		}
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

	async function runStep(
		step: SequenceStep,
		frame: number,
		src: FrameSource,
		mode: SequenceMode
	) {
		checkStop(step)
		currentStep.value = step
		patchProgress({step, status: 'running'})
		switch (step) {
			case 'cut':
				return stepCut(frame)
			case 'extend':
				return stepExtend(frame)
			case 'rig':
				return stepRig(frame, src)
			case 'led':
				return stepLed(frame, src, mode)
			case 'settle':
				return stepSettle()
			case 'capture':
				return stepCapture(frame, mode === 'replay' ? 'replay' : 'main', src)
			case 'park':
				return stepPark(frame)
			case 'retract':
				return stepRetract(frame)
		}
	}

	//--------------------------------------------------------------------------
	// Driving

	/**
	 * Run one frame from `fromStep` (default: the first step, or where the
	 * saved progress for that frame left off). `rig` and `led` run concurrently.
	 */
	async function runFrame(
		frame: number,
		fromStep: SequenceStep | undefined,
		mode: SequenceMode,
		range?: [number, number]
	) {
		const steps = stepsFor(mode)
		const saved = project.addsub.sequence
		const resume =
			saved && saved.frame === frame && saved.status !== 'done' && (saved.mode ?? 'shoot') === mode
		const known = (s: SequenceStep) => steps.includes(s)
		let done = resume ? saved.done.filter(known) : []
		const start = fromStep ?? (resume && known(saved.step) ? saved.step : steps[0])
		if (fromStep) {
			done = done.filter(s => steps.indexOf(s) < steps.indexOf(fromStep))
		}

		setProgress({
			mode,
			range,
			frame,
			step: start,
			done,
			status: 'running',
			returnPosition: resume ? saved.returnPosition : undefined,
			updatedAt: Date.now(),
		})

		const src = resolveSource(frame, mode)
		const isDone = (s: SequenceStep) => !!project.addsub.sequence?.done.includes(s)

		for (const step of steps.slice(steps.indexOf(start))) {
			if (isDone(step)) continue
			if (step === 'rig' || step === 'led') {
				// Different devices: move the rig and light the wall at once.
				const tasks: Promise<void>[] = []
				for (const s of ['rig', 'led'] as const) {
					if (steps.includes(s) && !isDone(s)) {
						tasks.push(runStep(s, frame, src, mode).then(() => markDone(s)))
					}
				}
				const results = await Promise.allSettled(tasks)
				const failed = results.find(r => r.status === 'rejected')
				if (failed && failed.status === 'rejected') throw failed.reason
				continue
			}
			await runStep(step, frame, src, mode)
			markDone(step)
		}
		patchProgress({status: 'done', step: steps[steps.length - 1]})
		currentStep.value = null
	}

	/**
	 * Start at `frame` (default: the capture frame, resuming saved progress if
	 * it is for that frame). With `continuous`, keep shooting following frames
	 * until `stop()`, the previz runs out, or an error.
	 */
	async function start(
		opts: {
			frame?: number
			fromStep?: SequenceStep
			continuous?: boolean
			mode?: SequenceMode
			/** Replay: inclusive range of timeline frames to re-shoot. */
			range?: [number, number]
		} = {}
	) {
		if (running.value) return
		const mode: SequenceMode = opts.mode ?? 'shoot'
		running.value = true
		continuous.value = mode === 'replay' ? true : (opts.continuous ?? false)
		stopRequested.value = false
		abort = new AbortController()
		warnings.value = []
		message.value = null

		let frame = opts.frame ?? project.captureShot.frame
		let fromStep = opts.fromStep
		const range = opts.range

		try {
			for (;;) {
				await runFrame(frame, fromStep, mode, range)
				fromStep = undefined
				if (!continuous.value || stopRequested.value) break
				if (mode === 'replay') {
					frame += 1
					// Skip frames without a recorded shot; stop at the range end.
					while (range && frame <= range[1] && !project.shot(frame, 0)?.rig) frame++
					if (!range || frame > range[1]) break
				} else {
					frame = project.captureShot.frame
					if (!hasSource(frame)) {
						message.value = `No plan or previz data for frame ${frame} — stopped`
						break
					}
				}
			}
			message.value = mode === 'replay' ? 'Replay done' : continuous.value ? 'Stopped' : 'Done'
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
				step: step ?? project.addsub.sequence?.step ?? stepsFor(mode)[0],
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

	/**
	 * Emergency stop: abort the sequence and feed-hold BOTH machines at once
	 * (controlled deceleration, no lost steps), then stop the mill's spindle.
	 * Works whether or not a sequence is running. Recovery is manual: resume
	 * (~) or soft reset from the machine panels, then Resume the sequence.
	 */
	async function estop() {
		stopRequested.value = true
		abort?.abort()
		await Promise.allSettled([
			mill.connected ? mill.feedHold() : Promise.resolve(),
			rig.connected ? rig.feedHold() : Promise.resolve(),
		])
		if (mill.connected) await mill.spindleStop().catch(() => {})
		if (!running.value) {
			message.value = 'EMERGENCY STOP — both machines on hold'
		}
	}

	/** Resume the saved progress (same frame, from the step it stopped at). */
	function resume(fromStep?: SequenceStep) {
		const p = project.addsub.sequence
		if (!p) return start()
		return start({
			frame: p.frame,
			fromStep: fromStep ?? p.step,
			mode: p.mode ?? 'shoot',
			range: p.range,
			continuous: p.mode === 'replay',
		})
	}

	/**
	 * Replay pass (§7.2): re-shoot every recorded frame in `range` (inclusive,
	 * default = preview in/out) with its recorded pose lifted to the current
	 * k_base, its LED image and exposure, into a "replay k<n>" layer.
	 */
	function startReplay(range?: [number, number]) {
		const r: [number, number] = range ?? [
			project.previewRange[0],
			project.previewRange[1],
		]
		let first = r[0]
		while (first <= r[1] && !project.shot(first, 0)?.rig) first++
		if (first > r[1]) {
			message.value = 'No recorded frames in range to replay'
			return Promise.resolve()
		}
		return start({frame: first, mode: 'replay', range: r})
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
		cutting: readonly(cutting),
		progress,
		stackHeight,
		registerCapture,
		start,
		startReplay,
		resume,
		stop,
		estop,
		pauseAfterFrame,
		clearProgress,
		appendBlock,
		planFor,
		setPlan,
		hasSource,
		goToPlan,
		steps: SEQUENCE_STEPS,
		replaySteps: REPLAY_STEPS,
	}
})
