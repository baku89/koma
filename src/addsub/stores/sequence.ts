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
 * driven by what each *recorded* shot has (rig axes lifted by the film-lift
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
import type {ConfigType} from 'tethr'
import {computed, readonly, ref, shallowRef, watch} from 'vue'

import {useCameraStore} from '@/stores/camera'
import {useProjectStore} from '@/stores/project'
import {
	AXES,
	type AxesPosition,
	type Axis,
	FluidNCError,
	prepareGCode,
	setWorkOffsetLine,
} from '@/utils/fluidnc'
import type {CompactToolpath} from '@/utils/fluidnc/toolpath.worker'
import {parseToolpathCached, toolpathTimeAt} from '@/utils/fluidnc/toolpathParser'
import {buzz, speak} from '@/utils/sound'

import {filmOriginMill} from '../coords'
import {
	cutFilePath,
	cutFor,
	type CutRun,
	type FrameCut,
	isCutDone,
	measuredTimeRatio,
	readProjectText,
	setCut,
} from '../cuts'
import {cameraPoseToRigAxes} from '../kinematics'
import {createMotionMeter, median} from '../motion'
import {
	type EffectivePlan,
	effectivePlanFor as effectivePlanForFrame,
	type FramePlan,
	PLAN_CAMERA_CONFIG_NAMES,
	PLAN_CHECKED_CONFIG_NAMES,
	planFor as planForFrame,
	setPlan as setPlanFrame,
} from '../plan'
import {
	REPLAY_STEPS,
	SEQUENCE_STEPS,
	type SequenceMode,
	type SequenceProgress,
	type SequenceStep,
	type ShotLedRecord,
} from '../projectData'
import {LIVE_SOURCE, useLedStore} from './led'
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
	const camera = useCameraStore()
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
	const cutting = ref<{frame: number; layer: number; path: string} | null>(null)

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
		/** Replay: the source shot's recorded pixels, for when it has no image. */
		ledWall?: string
		cameraConfigs?: Record<string, unknown>
		/** Timeline frame whose lighting `led.ensureFrame` should show. */
		ledFrame: number
	}

	function resolveSource(frame: number, mode: SequenceMode): FrameSource {
		const {calibration, filmLift} = project.addsub
		if (mode === 'replay') {
			const src = project.shot(frame, 0)
			if (!src?.rig || src.rig.x === undefined) {
				return {rigTarget: null, ledFile: null, ledFrame: frame}
			}
			// Raise the recorded axes by the blocks added since (§7.2).
			const dLift = filmLift - (src.filmLift ?? 0)
			const r = src.rig
			return {
				rigTarget: {
					x: r.x ?? 0,
					y: (r.y ?? 0) + dLift,
					z: r.z ?? 0,
					a: r.a ?? 0,
					b: r.b ?? 0,
					c: r.c ?? 0,
				},
				ledFile: ledImageOf(src.led),
				ledWall: src.led?.wall,
				cameraConfigs: src.cameraConfigs as Record<string, unknown> | undefined,
				ledFrame: frame,
			}
		}
		// The koma-side plan for this frame (plan.ts) overrides previz field by
		// field: explicit rig axes first, else a camera pose to solve, else previz.
		const pf = previz.frameFor(frame)
		const plan = effectivePlan(frame)?.plan
		const rigTarget =
			planRigTarget(plan) ??
			(pf?.pose ? cameraPoseToRigAxes(pf.pose, filmLift, calibration) : null)
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

	/**
	 * The plan in force at a frame: its own, or one interpolated between the
	 * planned frames on either side (plan.ts). What Go / the sequence / the
	 * shoot condition all use.
	 */
	function effectivePlan(frame: number, layer = project.captureShot.layer): EffectivePlan | null {
		return effectivePlanForFrame(project, frame, layer)
	}

	function setPlan(frame: number, plan: FramePlan | null, layer = project.captureShot.layer) {
		setPlanFrame(project, frame, layer, plan)
	}

	/** Rig axes a plan asks for (explicit axes, else its camera pose solved). */
	function planRigTarget(plan: FramePlan | undefined): AxesPosition | null {
		if (!plan) return null
		if (plan.rig) return {...plan.rig}
		if (plan.camera) {
			const {calibration, filmLift} = project.addsub
			return cameraPoseToRigAxes(plan.camera, filmLift, calibration)
		}
		return null
	}

	/** The subset of a config export a plan keeps (plan.ts). */
	function planCameraConfigs(configs: Record<string, unknown>): Partial<ConfigType> {
		const out: Record<string, unknown> = {}
		for (const name of PLAN_CAMERA_CONFIG_NAMES) {
			const v = configs[name]
			if (v !== undefined && v !== null) out[name] = v
		}
		return out as Partial<ConfigType>
	}

	/**
	 * Make (or extend) the frame's plan from what is there now: the rig's
	 * machine position and/or the camera's current settings. Keeps whatever
	 * the plan already had that isn't replaced. Returns the stored plan.
	 */
	async function setPlanFromCurrent(
		frame: number,
		layer: number,
		what: {rig?: boolean; camera?: boolean} = {rig: true, camera: true}
	): Promise<FramePlan> {
		const plan: FramePlan = {...planFor(frame, layer)}
		const problems: string[] = []
		if (what.rig) {
			const m = rig.mpos
			if (rig.connected && m.x !== undefined) {
				plan.rig = {x: m.x, y: m.y, z: m.z, a: m.a, b: m.b, c: m.c}
				delete plan.camera
			} else {
				problems.push('Box Rig is not connected — rig pose not recorded')
			}
		}
		if (what.camera) {
			const tethr = camera.tethr
			if (tethr) {
				plan.cameraConfigs = planCameraConfigs(await tethr.exportConfigs())
			} else {
				problems.push('Camera is not connected — camera settings not recorded')
			}
		}
		if (!plan.rig && !plan.camera && !plan.cameraConfigs) {
			throw new SequenceError('rig', problems.join('; ') || 'Nothing to record')
		}
		setPlan(frame, plan, layer)
		if (problems.length) throw new SequenceError('rig', problems.join('; '))
		return plan
	}

	/** Whether the sequence has anything to shoot at this frame. */
	function hasSource(frame: number, layer = project.captureShot.layer) {
		return !!effectivePlan(frame, layer) || !!previz.frameFor(frame)
	}

	/**
	 * Bring the set to the frame's plan, now: move the rig to the planned pose
	 * and put the planned settings on the camera. This is the only way a plan
	 * moves anything outside the sequence — seeking never does. Same checks
	 * as the sequence's rig step. Does what it can and reports the rest: a
	 * plan with only camera settings needs no rig, and vice versa.
	 */
	async function goToPlan(
		frame = project.captureShot.frame,
		layer = project.captureShot.layer,
		what: {rig?: boolean; camera?: boolean} = {rig: true, camera: true}
	) {
		if (running.value) throw new SequenceError('rig', 'Sequence is running')
		const eff = effectivePlan(frame, layer)
		if (!eff) throw new SequenceError('rig', `Frame ${frame}: no plan`)
		const {plan} = eff
		const target = planRigTarget(plan)
		const configs = plan.cameraConfigs
		if (!target && !configs) throw new SequenceError('rig', `Frame ${frame}: plan is empty`)
		const problems: string[] = []

		if (what.rig !== false && target) {
			if (!rig.connected) {
				problems.push('Box Rig is not connected')
			} else {
				rigLimitsCheck(target)
				message.value = `Moving rig to plan for frame ${frame}${eff.kind === 'interpolated' ? ' (interpolated)' : ''}`
				try {
					await rig.moveTo(target, {feed: project.addsub.rigFeed})
					message.value = null
				} catch (e) {
					message.value = e instanceof Error ? e.message : String(e)
					throw e
				}
			}
		}
		if (what.camera !== false && configs) {
			const tethr = camera.tethr
			if (!tethr) {
				problems.push('Camera is not connected')
			} else {
				try {
					await tethr.importConfigs(planCameraConfigs(configs as Record<string, unknown>))
				} catch (e) {
					problems.push(`Camera settings: ${e instanceof Error ? e.message : String(e)}`)
				}
			}
		}
		if (problems.length) throw new SequenceError('rig', problems.join('; '))
	}

	/**
	 * Why the capture frame's plan is not met right now (empty when it is, or
	 * when the frame has no plan): the rig outside `planTolerance` of the
	 * planned pose, or a checked camera config differing from the planned
	 * value. Registered as a shoot-alert provider (shootConditions.ts).
	 */
	function planAlerts(frame = project.captureShot.frame, layer = project.captureShot.layer): string[] {
		const eff = effectivePlan(frame, layer)
		if (!eff) return []
		const out: string[] = []
		const where = eff.kind === 'interpolated' ? `plan (interpolated ${eff.from}–${eff.to})` : 'plan'
		const target = planRigTarget(eff.plan)
		if (target) {
			if (!rig.connected) {
				out.push(`Box Rig must be connected to reach the ${where}`)
			} else {
				const tol = project.addsub.planTolerance
				const m = rig.mpos
				for (const axis of AXES) {
					const want = target[axis]
					if (want === undefined) continue
					const have = m[axis]
					const rotary = axis === 'a' || axis === 'b' || axis === 'c'
					const limit = rotary ? tol.rotary : tol.linear
					if (have === undefined || Math.abs(have - want) > limit) {
						out.push(
							`Rig ${axis.toUpperCase()} is ${have === undefined ? '?' : have.toFixed(2)}, ${where} wants ${want.toFixed(2)}`
						)
					}
				}
			}
		}
		const configs = eff.plan.cameraConfigs as Record<string, unknown> | undefined
		if (configs) {
			if (!camera.tethr) {
				out.push(`Camera must be connected to apply the ${where}`)
			} else {
				for (const name of PLAN_CHECKED_CONFIG_NAMES) {
					const want = configs[name]
					if (want === undefined || want === null) continue
					const cfg = (camera as unknown as Record<string, {value: unknown} | undefined>)[name]
					const have = cfg?.value
					if (have === undefined || have === null) continue // not reported by this camera
					const same =
						typeof want === 'number' && typeof have === 'number'
							? Math.abs(want - have) <= 1e-6
							: String(want) === String(have)
					if (!same) out.push(`${name} is ${String(have)}, ${where} wants ${String(want)}`)
				}
			}
		}
		return out
	}

	//--------------------------------------------------------------------------
	// Recall what a shot was taken with (timeline context menu / commands)

	/**
	 * Rig axes to reproduce a shot's camera position: the axes recorded at
	 * capture, lifted by the blocks added since (§7.2). Falls back to the
	 * frame's plan / previz pose when the shot recorded no axes (or there is no
	 * shot on that cell yet).
	 */
	function rigTargetForShot(frame: number, layer: number): AxesPosition | null {
		const {calibration, filmLift} = project.addsub
		const shot = project.shot(frame, layer)
		if (shot?.rig && shot.rig.x !== undefined) {
			const dLift = filmLift - (shot.filmLift ?? 0)
			const r = shot.rig
			return {
				x: r.x ?? 0,
				y: (r.y ?? 0) + dLift,
				z: r.z ?? 0,
				a: r.a ?? 0,
				b: r.b ?? 0,
				c: r.c ?? 0,
			}
		}
		const pf = previz.frameFor(frame)
		return (
			planRigTarget(effectivePlan(frame, layer)?.plan) ??
			(pf?.pose ? cameraPoseToRigAxes(pf.pose, filmLift, calibration) : null)
		)
	}

	/** The lighting image a shot recorded (the live feed's marker is not one). */
	function ledImageOf(rec: ShotLedRecord | undefined): string | null {
		return rec?.file && rec.file !== LIVE_SOURCE ? rec.file : null
	}

	/** Lighting image a shot was taken with, else the frame's previz lighting. */
	function ledFileForShot(frame: number, layer: number): string | null {
		return ledImageOf(project.shot(frame, layer)?.led) ?? previz.frameFor(frame)?.led ?? null
	}

	/**
	 * Move the rig to where the camera was for this shot, now. Same checks as
	 * the sequence's rig step; refuses while the sequence runs. With `axes`,
	 * only those axes move (the others stay where they are).
	 */
	async function recallRig(frame: number, layer: number, axes?: readonly Axis[]) {
		if (running.value) throw new SequenceError('rig', 'Sequence is running')
		const full = rigTargetForShot(frame, layer)
		if (!full) throw new SequenceError('rig', `Frame ${frame}: no camera position recorded`)
		let target = full
		if (axes) {
			target = {}
			for (const axis of axes) {
				if (full[axis] !== undefined) target[axis] = full[axis]
			}
			if (Object.keys(target).length === 0) {
				throw new SequenceError('rig', `Frame ${frame}: no position recorded for ${axes.join(', ').toUpperCase()}`)
			}
		}
		if (!rig.connected) throw new SequenceError('rig', 'Box Rig is not connected')
		rigLimitsCheck(target)
		message.value = axes
			? `Moving rig ${axes.join('').toUpperCase()} to the camera position of frame ${frame}`
			: `Moving rig to the camera position of frame ${frame}`
		try {
			await rig.moveTo(target, {feed: project.addsub.rigFeed})
			message.value = null
		} catch (e) {
			message.value = e instanceof Error ? e.message : String(e)
			throw e
		}
	}

	/**
	 * Put the lighting this shot was taken with on the LED wall. The pixels
	 * recorded at capture go back verbatim; only when blocks were appended
	 * since (§7.2) and the shot has a lighting image is the image re-sampled
	 * with the current lift instead, as the rig recall lifts Y. A shot with no
	 * recorded pixels falls back to its image, then the frame's previz
	 * lighting. Turns the work light off; the wall keeps showing it until the
	 * capture frame or a lighting mode changes.
	 */
	async function recallLed(frame: number, layer: number) {
		const shot = project.shot(frame, layer)
		const wall = shot?.led?.wall
		const lifted = (shot?.filmLift ?? 0) !== project.addsub.filmLift
		const resample = !wall || (lifted && !!ledImageOf(shot?.led))
		const file = resample ? ledFileForShot(frame, layer) : null
		if (resample && !file) throw new SequenceError('led', `Frame ${frame}: no lighting recorded`)
		if (!led.connected) throw new SequenceError('led', 'LED wall is not connected')
		led.setWorkLight(false)
		try {
			if (file) await led.showFile(file, {force: true})
			else if (wall) await led.showWallRecord(wall)
		} catch (e) {
			throw new SequenceError('led', e instanceof Error ? e.message : String(e))
		}
	}

	//--------------------------------------------------------------------------
	// Cuts (cuts.ts): which G-code a frame runs, and running it

	/**
	 * The G-code a frame has to run before it is shot: a file dropped on its
	 * cell first, else the cut previz plans. `cut` is the record holding the
	 * run (may exist for a previz cut, may be missing).
	 */
	function gcodeFor(
		frame: number,
		layer = project.captureShot.layer
	): {path: string; name: string; source: 'file' | 'previz'; cut: FrameCut | undefined} | null {
		const cut = cutFor(project, frame, layer)
		if (cut?.source === 'file') return {path: cut.file, name: cut.name, source: 'file', cut}
		const pf = previz.frameFor(frame)
		if (pf?.gcode) {
			const path = `${PREVIZ_DIR}/${pf.gcode}`
			return {path, name: pf.gcode, source: 'previz', cut}
		}
		return null
	}

	/** Parsed toolpath of a project file (worker, cached by path + stamp). */
	function toolpathFor(path: string, stamp: number | string): Promise<CompactToolpath | null> {
		return parseToolpathCached(`${path}@${stamp}`, async () => {
			const root = project.directoryHandle
			if (!root) return null
			try {
				return await readProjectText(root, path)
			} catch {
				return null
			}
		})
	}

	/** Cache stamp for a frame's G-code (the dropped file's addedAt, or previz's mtime). */
	function gcodeStamp(g: {source: 'file' | 'previz'; cut?: FrameCut}): number {
		return g.source === 'file' ? (g.cut?.addedAt ?? 0) : (previz.lastModified ?? 0)
	}

	/**
	 * Attach a G-code file to a frame: copy it into the project folder
	 * (`gcode/<layer id>/`), parse it for the line count and time estimate,
	 * and record it as the frame's cut — replacing a previous file (and its
	 * run) on that frame.
	 */
	async function attachCutFile(frame: number, layer: number, file: File): Promise<FrameCut> {
		const layerId = project.layers[layer]?.id
		if (layerId === undefined) throw new SequenceError('cut', `No layer ${layer}`)
		const path = cutFilePath(layerId, frame, file.name)
		const previous = cutFor(project, frame, layer)
		await project.writeProjectFile(path, file)
		const addedAt = Date.now()
		const text = await file.text()
		const lines = prepareGCode(text).length
		const tp = await parseToolpathCached(`${path}@${addedAt}`, async () => text)
		const cut: FrameCut = {
			source: 'file',
			file: path,
			name: file.name,
			addedAt,
			lines,
			estimatedSec: tp?.seconds,
			run: null,
		}
		setCut(project, frame, layer, cut)
		if (previous?.source === 'file' && previous.file !== path) {
			await project.removeProjectFile(previous.file).catch(() => {})
		}
		return cut
	}

	/** Detach a dropped file from a frame (the previz cut, if any, applies again). */
	async function removeCut(frame: number, layer: number) {
		const cut = cutFor(project, frame, layer)
		if (!cut) return
		setCut(project, frame, layer, null)
		if (cut.source === 'file') await project.removeProjectFile(cut.file).catch(() => {})
	}

	/** Forget a frame's run (it will be cut again by the sequence / warned about). */
	function clearCutRun(frame: number, layer: number) {
		const cut = cutFor(project, frame, layer)
		if (!cut) return
		if (cut.source === 'file') setCut(project, frame, layer, {...cut, run: null})
		else setCut(project, frame, layer, null)
	}

	function recordRun(frame: number, layer: number, g: {path: string; name: string; source: 'file' | 'previz'; cut?: FrameCut}, run: CutRun) {
		const base: FrameCut = g.cut ?? {
			source: g.source,
			file: g.path,
			name: g.name,
			addedAt: Date.now(),
		}
		setCut(project, frame, layer, {...base, file: g.path, name: g.name, run})
	}

	/**
	 * Stream the frame's G-code to the mill (G54 first pointed at the film
	 * origin for the current lift, §7.1) and record the run. Shared by the
	 * sequence's `cut` step and the stand-alone Cut button.
	 */
	/**
	 * The `G10 L2 P1 …` a cut sends first to put G54 on the film origin, or
	 * null when the project leaves the machine's work zero alone
	 * (`cutSetsWorkOffset` off).
	 */
	function cutWorkOffsetLine(): string | null {
		const {calibration, filmLift, cutSetsWorkOffset} = project.addsub
		if (!cutSetsWorkOffset) return null
		const origin = filmOriginMill(filmLift, calibration.filmOriginWorld, calibration.millOffset)
		return setWorkOffsetLine(1, {x: origin[0], y: origin[1], z: origin[2]})
	}

	async function runCut(frame: number, layer: number) {
		const g = gcodeFor(frame, layer)
		if (!g) {
			warn(`Frame ${frame}: no G-code — skipping cut`)
			return
		}
		if (!mill.connected) throw new SequenceError('cut', 'Mill is not connected')
		const root = project.directoryHandle
		if (!root) throw new SequenceError('cut', 'Project folder is not available')
		let text: string
		try {
			text = await readProjectText(root, g.path)
		} catch {
			throw new SequenceError('cut', `G-code file missing: ${g.path}`)
		}
		const lines = prepareGCode(text).map(l => l.line)
		if (lines.length === 0) {
			warn(`Frame ${frame}: empty G-code — skipping cut`)
			return
		}
		const stamp = gcodeStamp(g)
		cuttingToolpath.value = await toolpathFor(g.path, stamp)
		// Point G54 at the film origin for the current lift (§7.1) — only when
		// asked to. Otherwise the file runs in the work zero set on the machine,
		// untouched: G10 L2 is persistent, so sending it uninvited would throw
		// away a zero that was touched off by hand.
		const {filmLift} = project.addsub
		const offsetLine = cutWorkOffsetLine()
		if (offsetLine) await mill.send(offsetLine)
		message.value = `Cutting frame ${frame} (${lines.length} lines)`
		cutting.value = {frame, layer, path: g.path}
		const startedAt = Date.now()
		cutStartedAt.value = startedAt
		const run: CutRun = {
			startedAt,
			durationMs: 0,
			linesSent: 0,
			total: lines.length,
			done: false,
			filmLift,
			estimatedSec: cuttingToolpath.value?.seconds ?? g.cut?.estimatedSec,
		}
		try {
			await mill.stream(lines, {signal: signal()})
			run.linesSent = lines.length
			await mill.waitIdle({signal: signal()})
			run.done = true
		} catch (e) {
			run.linesSent = mill.streamProgress?.index ?? run.linesSent
			run.error = e instanceof Error ? e.message : String(e)
			throw e
		} finally {
			run.durationMs = Date.now() - startedAt
			recordRun(frame, layer, g, run)
			cutting.value = null
			cutStartedAt.value = null
			cuttingToolpath.value = null
		}
	}

	function stepCut(frame: number) {
		return runCut(frame, project.captureShot.layer)
	}

	/**
	 * Cut one frame now, outside the sequence (the title bar's Cut button):
	 * same G54 setup and run record as the `cut` step. Refuses while the
	 * sequence runs; `stop()` / ESTOP feed-hold it like any step.
	 */
	async function cutFrame(frame = project.captureShot.frame, layer = project.captureShot.layer) {
		if (running.value) throw new SequenceError('cut', 'Sequence is running')
		if (!gcodeFor(frame, layer)) throw new SequenceError('cut', `Frame ${frame}: no G-code`)
		running.value = true
		continuous.value = false
		stopRequested.value = false
		abort = new AbortController()
		currentStep.value = 'cut'
		message.value = null
		try {
			await runCut(frame, layer)
			message.value = `Frame ${frame} cut`
		} catch (e) {
			const stopped =
				stopRequested.value ||
				(e instanceof FluidNCError && e.kind === 'aborted') ||
				(e instanceof SequenceError && e.message === 'Stopped')
			message.value = stopped ? 'Cut stopped' : `Cut error: ${e instanceof Error ? e.message : String(e)}`
			if (!stopped) throw e
		} finally {
			running.value = false
			currentStep.value = null
			abort = null
		}
	}

	//--------------------------------------------------------------------------
	// After a manual shot: set up the next frame (auto move, auto run)

	/**
	 * Auto run, the operator-in-the-loop way of shooting: each manual shot
	 * sets up the next frame — the rig goes to its plan, its G-code is cut —
	 * and a buzzer says when it is ready. The operator cleans the work, looks,
	 * and presses the shutter, which starts the next round. Not persisted and
	 * off at startup: it makes the machines move without being asked.
	 */
	const autoRun = ref(false)

	/** Straight-line X/Y/Z distance (mm) from where the rig is to `target`. */
	function rigTravel(target: AxesPosition): number {
		const m = rig.mpos
		let sum = 0
		for (const axis of ['x', 'y', 'z'] as const) {
			const want = target[axis]
			const have = m[axis]
			if (want === undefined || have === undefined) continue
			sum += (want - have) ** 2
		}
		return Math.sqrt(sum)
	}

	/** Whether the rig already stands at `target`, within the plan tolerance. */
	function rigAt(target: AxesPosition): boolean {
		const tol = project.addsub.planTolerance
		const m = rig.mpos
		return AXES.every(axis => {
			const want = target[axis]
			if (want === undefined) return true
			const have = m[axis]
			const rotary = axis === 'a' || axis === 'b' || axis === 'c'
			return have !== undefined && Math.abs(have - want) <= (rotary ? tol.rotary : tol.linear)
		})
	}

	/**
	 * Called once a manual shot has been placed and the capture cursor stands
	 * on the next frame. Moves the rig to that frame's plan when it is close
	 * (`autoMoveMaxDistance`); with auto run on, then cuts the frame's G-code
	 * and buzzes. Never throws: what went wrong is spoken and left in
	 * `message`, and a failure switches auto run off.
	 */
	async function afterShot(frame = project.captureShot.frame, layer = project.captureShot.layer) {
		if (running.value) return
		const auto = autoRun.value
		const maxMove = project.addsub.autoMoveMaxDistance
		const target = planRigTarget(effectivePlan(frame, layer)?.plan)
		const g = gcodeFor(frame, layer)
		const needsCut = auto && !!g && !(g.cut?.run?.done && g.cut.file === g.path)

		let move: AxesPosition | null = null
		const notes: string[] = []
		if (target && maxMove > 0) {
			if (!rig.connected) {
				if (auto) notes.push('Box Rig is not connected, camera not moved')
			} else if (!rigAt(target)) {
				const distance = rigTravel(target)
				if (distance >= maxMove) {
					notes.push(`Camera not moved, the plan is ${Math.round(distance)} millimetres away`)
				} else {
					move = target
				}
			}
		}
		if (auto && !g) notes.push(`Frame ${frame} has no G-code`)

		if (!move && !needsCut) {
			if (notes.length) message.value = notes.join('. ')
			if (auto) {
				// Nothing to wait for: say so right away rather than leave the
				// operator listening for a buzzer that will not come.
				buzz(g ? 'done' : 'error')
				for (const note of notes) void speak(note)
			}
			return
		}

		running.value = true
		continuous.value = false
		stopRequested.value = false
		abort = new AbortController()
		try {
			if (move) {
				currentStep.value = 'rig'
				rigLimitsCheck(move)
				message.value = `Moving rig to the plan of frame ${frame}`
				await rig.moveTo(move, {feed: project.addsub.rigFeed, signal: signal()})
			}
			if (needsCut) {
				currentStep.value = 'cut'
				await runCut(frame, layer)
			}
			message.value = [auto ? `Frame ${frame} is ready` : `Rig at the plan of frame ${frame}`, ...notes].join('. ')
			if (auto) {
				buzz('done')
				for (const note of notes) void speak(note)
			}
		} catch (e) {
			const stopped =
				stopRequested.value ||
				(e instanceof FluidNCError && e.kind === 'aborted') ||
				(e instanceof SequenceError && e.message === 'Stopped')
			const what = currentStep.value === 'cut' ? 'Cut' : 'Rig move'
			message.value = stopped
				? `${what} stopped`
				: `${what} failed: ${e instanceof Error ? e.message : String(e)}`
			buzz('error')
			void speak(stopped ? `${what} stopped` : `${what} failed`)
			if (auto) {
				autoRun.value = false
				message.value += ' — auto run is off'
			}
		} finally {
			running.value = false
			currentStep.value = null
			abort = null
		}
	}

	// ETA while cutting: the parser's estimate for the lines not yet sent,
	// scaled by how this run is going so far (once enough of it has elapsed to
	// mean something), else by the ratio measured on the project's earlier
	// runs. `now` ticks once a second only while a cut is in progress.
	const cuttingToolpath = shallowRef<CompactToolpath | null>(null)
	const cutStartedAt = ref<number | null>(null)
	const now = ref(Date.now())
	let tick: ReturnType<typeof setInterval> | null = null
	watch(cutStartedAt, t => {
		if (tick) clearInterval(tick)
		tick = t === null ? null : setInterval(() => (now.value = Date.now()), 1000)
	})

	const cutProgress = computed(() => {
		if (!cutting.value) return null
		const p = mill.streamProgress
		const sent = p?.index ?? 0
		const total = p?.total ?? 0
		const elapsedMs = cutStartedAt.value === null ? 0 : now.value - cutStartedAt.value
		const tp = cuttingToolpath.value
		let remainingMs: number | null = null
		if (tp) {
			const est = toolpathTimeAt(tp, sent)
			const ratio =
				est.elapsed > 20 && elapsedMs > 20000
					? elapsedMs / 1000 / est.elapsed
					: measuredTimeRatio(project)
			remainingMs = est.remaining * ratio * 1000
		}
		return {
			frame: cutting.value.frame,
			layer: cutting.value.layer,
			sent,
			total,
			fraction: total > 0 ? sent / total : 0,
			elapsedMs,
			remainingMs,
		}
	})

	/**
	 * Why the frame must not be shot yet, cut-wise: it has G-code that has not
	 * run to the end (with its current file). Empty when there is no G-code,
	 * or the project doesn't require cuts.
	 */
	function cutAlerts(frame = project.captureShot.frame, layer = project.captureShot.layer): string[] {
		if (!project.addsub.requireCut) return []
		const g = gcodeFor(frame, layer)
		if (!g) return []
		if (isCutDone(g.cut) && g.cut?.file === g.path) return []
		const run = g.cut?.run
		const state = run
			? run.error
				? `stopped at line ${run.linesSent}/${run.total}`
				: 'incomplete'
			: 'not cut yet'
		return [`Frame ${frame}: G-code ${g.name} ${state}`]
	}

	/**
	 * Whether the mill has to take part in this frame. A frame with no G-code
	 * (a rig-only plan, a `cut: false` previz frame) can be shot with the mill
	 * offline: the table then simply stays where the operator left it.
	 */
	function millNeeded(frame: number) {
		return !!gcodeFor(frame)
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
		if (!src.ledFile && !src.ledWall) {
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
			if (mode === 'replay' && src.ledFile) {
				const blob = await previz.readBlob(src.ledFile)
				await led.showImageBlob(blob, {file: src.ledFile})
			} else if (mode === 'replay' && src.ledWall) {
				// No image to re-sample: the recorded pixels go back as they were.
				await led.showWallRecord(src.ledWall)
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

	/** Wait `ms`; rejects as stopped when the sequence is aborted meanwhile. */
	function sleep(ms: number, step: SequenceStep) {
		return new Promise<void>((resolve, reject) => {
			const s = signal()
			const stopped = () => {
				clearTimeout(t)
				reject(new SequenceError(step, 'Stopped'))
			}
			const t = setTimeout(() => {
				s.removeEventListener('abort', stopped)
				resolve()
			}, ms)
			if (s.aborted) stopped()
			else s.addEventListener('abort', stopped, {once: true})
		})
	}

	//--------------------------------------------------------------------------
	// Settle: wait for the hanging camera to stop swinging (motion.ts)

	/** "Still" = live view motion within this factor of its level at rest. */
	const STILL_FACTOR = 1.5
	/** …for this long without a break. */
	const STILL_HOLD_MS = 1000
	const MOTION_SAMPLE_MS = 50
	const REST_MEASURE_MS = 800
	/** No new live view frame for this long: give up judging by it. */
	const LIVE_STALL_MS = 1500

	/**
	 * Live view motion with the rig at rest (sensor noise, flicker): what the
	 * settle step compares against. Measured before each rig move and while
	 * holding still, and only ever lowered during a run — the camera may
	 * still be swinging a little from the frame before, which must not loosen
	 * the yardstick frame after frame. A settle that never gets there (the
	 * noise really went up, e.g. brighter lighting) starts it afresh.
	 */
	let restMotion: number | null = null

	function lowerRestMotion(level: number) {
		restMotion = restMotion === null ? level : Math.min(restMotion, level)
	}

	async function measureRest(step: SequenceStep) {
		const stream = camera.liveview.value
		if (!project.addsub.settleStill || !stream) return
		const meter = createMotionMeter(stream)
		try {
			const samples: number[] = []
			const until = performance.now() + REST_MEASURE_MS
			while (performance.now() < until) {
				await sleep(MOTION_SAMPLE_MS, step)
				const v = meter.sample()
				if (v !== null) samples.push(v)
			}
			if (samples.length >= 3) lowerRestMotion(median(samples))
		} finally {
			meter.dispose()
		}
	}

	/**
	 * Wait `settleMs`, then (with `settleStill`) on until the live view is as
	 * quiet as it was at rest, for at most `settleMaxMs` in all. Without a
	 * live view or a rest level it is the fixed wait alone.
	 */
	async function stepSettle() {
		const {settleMs, settleStill, settleMaxMs} = project.addsub
		const stream = camera.liveview.value
		if (!settleStill || !stream || restMotion === null) {
			message.value = `Settling ${settleMs} ms`
			await sleep(settleMs, 'settle')
			return
		}
		const limit = restMotion * STILL_FACTOR
		const longest = Math.max(settleMs, settleMaxMs)
		const meter = createMotionMeter(stream)
		const t0 = performance.now()
		let stillSince: number | null = null
		let held: number[] = []
		let lastFrame = t0
		message.value = 'Settling'
		try {
			for (;;) {
				await sleep(MOTION_SAMPLE_MS, 'settle')
				const now = performance.now()
				const motion = meter.sample()
				if (motion !== null) {
					lastFrame = now
					if (motion > limit) {
						stillSince = null
						held = []
					} else {
						stillSince ??= now
						held.push(motion)
					}
					message.value = `Settling — motion ${motion.toFixed(2)} (still ≤ ${limit.toFixed(2)})`
				}
				const elapsed = now - t0
				if (elapsed < settleMs) continue
				if (stillSince !== null && now - stillSince >= STILL_HOLD_MS) {
					lowerRestMotion(median(held))
					return
				}
				if (now - lastFrame >= LIVE_STALL_MS) {
					warn('Settle: the live view is not updating — waited the fixed time only')
					return
				}
				if (elapsed >= longest) {
					warn(`Settle: still moving after ${Math.round(longest / 1000)} s — shot anyway`)
					restMotion = null
					return
				}
			}
		} finally {
			meter.dispose()
		}
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
				const created = project.addLayer(`Replay +${project.addsub.filmLift}mm`)
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
				// The rig is at rest now: take the level "still" is judged against.
				if (steps.includes('rig') && !isDone('rig')) await measureRest('rig')
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
	 * until `stop()`, the previz runs out, or an error — or, given a `range`,
	 * every frame up to its end (shot or not: a frame that already has a shot
	 * is re-shot, the old one goes to the trash).
	 */
	async function start(
		opts: {
			frame?: number
			fromStep?: SequenceStep
			continuous?: boolean
			mode?: SequenceMode
			/** Inclusive range of timeline frames to run (replay: to re-shoot). */
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
		restMotion = null

		let frame = opts.frame ?? project.captureShot.frame
		let fromStep = opts.fromStep
		const range = opts.range
		let ended: string | null = null

		try {
			for (;;) {
				await runFrame(frame, fromStep, mode, range)
				fromStep = undefined
				// Each shot drags the out-point to the capture cursor; a run over
				// in → out keeps the range it was given.
				if (mode === 'shoot' && range) project.$patch({previewRange: [range[0], range[1]]})
				if (!continuous.value || stopRequested.value) break
				if (mode === 'replay') {
					frame += 1
					// Skip frames without a recorded shot; stop at the range end.
					while (range && frame <= range[1] && !project.shot(frame, 0)?.rig) frame++
					if (!range || frame > range[1]) break
				} else {
					frame = range ? frame + 1 : project.captureShot.frame
					if (range && frame > range[1]) {
						ended = `Frames ${range[0]}–${range[1]} done`
						break
					}
					if (!hasSource(frame)) {
						ended = `No plan or previz data for frame ${frame} — stopped`
						break
					}
				}
			}
			message.value =
				ended ?? (mode === 'replay' ? 'Replay done' : continuous.value ? 'Stopped' : 'Done')
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
			if (mode === 'shoot' && range) project.$patch({previewRange: [range[0], range[1]]})
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
		autoRun.value = false
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
			continuous: p.mode === 'replay' || !!p.range,
		})
	}

	/**
	 * Shoot every frame of `range` (inclusive, default = preview in/out) in
	 * order, on the capture layer: the normal per-frame sequence, started at
	 * the in-point and stopping after the out-point.
	 */
	function startRange(range?: [number, number]) {
		const r: [number, number] = range ?? [project.previewRange[0], project.previewRange[1]]
		if (!hasSource(r[0])) {
			message.value = `No plan or previz data for frame ${r[0]}`
			return Promise.resolve()
		}
		return start({frame: r[0], continuous: true, range: r})
	}

	/**
	 * Replay pass (§7.2): re-shoot every recorded frame in `range` (inclusive,
	 * default = preview in/out) with its recorded pose lifted to the current
	 * film lift, its LED image and exposure, into a "Replay +<lift>mm" layer.
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
	// Block append (§7)

	/**
	 * A block of `height` mm was glued under the stack: the film frame rises
	 * by that much. Remembers the height as the default for the next one.
	 */
	function appendBlock(height = project.addsub.blockHeight) {
		project.addsub.filmLift += height
		project.addsub.blockHeight = height
	}

	return {
		running: readonly(running),
		continuous: readonly(continuous),
		currentStep: readonly(currentStep),
		message: readonly(message),
		warnings: readonly(warnings),
		cutting: readonly(cutting),
		progress,
		registerCapture,
		start,
		startRange,
		startReplay,
		resume,
		stop,
		estop,
		pauseAfterFrame,
		clearProgress,
		appendBlock,
		gcodeFor,
		toolpathFor,
		gcodeStamp,
		attachCutFile,
		removeCut,
		clearCutRun,
		cutFrame,
		autoRun,
		afterShot,
		cutProgress,
		cutAlerts,
		planFor,
		effectivePlan,
		setPlan,
		setPlanFromCurrent,
		planAlerts,
		hasSource,
		goToPlan,
		recallRig,
		recallLed,
		rigTargetForShot,
		cutWorkOffsetLine,
		ledFileForShot,
		steps: SEQUENCE_STEPS,
		replaySteps: REPLAY_STEPS,
	}
})
