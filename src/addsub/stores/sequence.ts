/**
 * The per-frame shooting sequence (ADDSUB.md §2), as a resumable step machine:
 *
 *   (rig ∥ led) → cut → extend → settle → capture → park → retract
 *
 * (Spindle stop and head retract are part of the CAM-generated G-code, so
 * they belong to `cut`, not to a step of their own. `rig` and `led` talk to
 * different devices and run concurrently, and go first so the camera has
 * the whole cut to settle and the operator can touch it up while cleaning
 * up — `settle` then only covers the table coming out.)
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
import {basenameOf, layerGcodeDir} from '@/utils'
import {
	AXES,
	type AxesPosition,
	type Axis,
	FluidNCError,
	prepareGCode,
} from '@/utils/fluidnc'
import type {CompactToolpath} from '@/utils/fluidnc/toolpath.worker'
import {parseToolpathCached, toolpathTimeAt} from '@/utils/fluidnc/toolpathParser'
import {buzz, speak} from '@/utils/sound'

import {MILL_SHOOT_POSITION} from '../config'
import {
	cutFilePath,
	cutFor,
	type CutPreset,
	cutPresetPath,
	type CutRun,
	CUTS_DIR,
	type FrameCut,
	isCutDone,
	measuredTimeRatio,
	readProjectText,
	setCut,
} from '../cuts'
import {aimRigAxes, cameraPoseToRigAxes} from '../kinematics'
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
import {SEQUENCE_STEPS, type SequenceProgress, type SequenceStep} from '../projectData'
import {useLedStore} from './led'
import {useMillStore, useRigStore} from './machines'
import {PREVIZ_DIR, usePrevizStore} from './previz'
import {useRigWorkStore} from './rigWork'

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
	const rigWork = useRigWorkStore()
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

	function markDone(step: SequenceStep) {
		const cur = project.addsub.sequence
		if (!cur) return
		const steps = SEQUENCE_STEPS
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
				// Said in work coordinates, as the panels show them.
				const work = (m: number) => rigWork.axisToWork(axis as Axis, m)
				throw new SequenceError(
					'rig',
					`Rig ${axis.toUpperCase()} = ${work(v).toFixed(3)} is outside [${work(range[0])}, ${work(range[1])}]`
				)
			}
		}
	}

	function warn(text: string) {
		warnings.value = [...warnings.value.slice(-19), text]
	}

	//--------------------------------------------------------------------------
	// What to do for a frame

	interface FrameSource {
		/** Machine coordinates. Partial: axes left out are not moved. */
		rigTarget: AxesPosition | null
		cameraConfigs?: Record<string, unknown>
	}

	function resolveSource(frame: number): FrameSource {
		const {calibration} = project.addsub
		// The koma-side plan for this frame (plan.ts) overrides previz field by
		// field: explicit rig axes first, else a camera pose to solve, else previz.
		const pf = previz.frameFor(frame)
		const plan = effectivePlan(frame)?.plan
		const rigTarget =
			planRigTarget(plan) ??
			(pf?.pose ? cameraPoseToRigAxes(pf.pose, calibration) : null)
		return {
			rigTarget,
			cameraConfigs: (plan?.cameraConfigs ?? pf?.cameraConfigs) as
				| Record<string, unknown>
				| undefined,
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

	/**
	 * Rig axes a plan asks for, in machine coordinates (its explicit axes —
	 * stored in work coordinates — else its camera pose solved).
	 */
	function planRigTarget(plan: FramePlan | undefined): AxesPosition | null {
		if (!plan) return null
		if (plan.rig) return rigWork.toMachine(plan.rig)
		if (plan.camera) {
			return cameraPoseToRigAxes(plan.camera, project.addsub.calibration)
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
	 * position (work coordinates) and/or the camera's current settings. Keeps whatever
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
				plan.rig = rigWork.toWork({x: m.x, y: m.y, z: m.z, a: m.a, b: m.b, c: m.c})
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
		what: {rig?: boolean; camera?: boolean; led?: boolean} = {rig: true, camera: true, led: true}
	) {
		if (running.value) throw new SequenceError('rig', 'Sequence is running')
		const eff = effectivePlan(frame, layer)
		if (!eff) throw new SequenceError('rig', `Frame ${frame}: no plan`)
		const {plan} = eff
		const target = planRigTarget(plan)
		const configs = plan.cameraConfigs
		if (!target && !configs && !plan.led) throw new SequenceError('rig', `Frame ${frame}: plan is empty`)
		const problems: string[] = []

		// The wall first: it has nothing to wait for and lights the move.
		if (what.led !== false && plan.led) {
			try {
				await led.showWallRecord(plan.led.file)
			} catch (e) {
				problems.push(`LED: ${e instanceof Error ? e.message : String(e)}`)
			}
		}

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
						const work = (m: number) => rigWork.axisToWork(axis, m).toFixed(2)
						out.push(
							`Rig ${axis.toUpperCase()} is ${have === undefined ? '?' : work(have)}, ${where} wants ${work(want)}`
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
	 * Rig axes (machine) to reproduce a shot's camera position: the axes
	 * recorded at capture. Falls back to the frame's plan / previz pose when
	 * the shot recorded no axes (or there is no shot on that cell yet).
	 */
	function rigTargetForShot(frame: number, layer: number): AxesPosition | null {
		const {calibration} = project.addsub
		const shot = project.shot(frame, layer)
		if (shot?.rig && shot.rig.x !== undefined) {
			const r = shot.rig
			return rigWork.toMachine({
				x: r.x ?? 0,
				y: r.y ?? 0,
				z: r.z ?? 0,
				a: r.a ?? 0,
				b: r.b ?? 0,
				c: r.c ?? 0,
			})
		}
		const pf = previz.frameFor(frame)
		return (
			planRigTarget(effectivePlan(frame, layer)?.plan) ??
			(pf?.pose ? cameraPoseToRigAxes(pf.pose, calibration) : null)
		)
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
	 * Turn tilt (A) and pan (B) so the camera looks at `target` (work
	 * coordinates, mm) from where the rig is now. Nothing else moves: X/Y/Z
	 * stay, and so does roll (C). Refuses while the sequence runs.
	 */
	async function aimRigAt(target: readonly [number, number, number]) {
		if (running.value) throw new SequenceError('rig', 'Sequence is running')
		if (!rig.connected) throw new SequenceError('rig', 'Box Rig is not connected')
		if (rig.mpos.x === undefined) throw new SequenceError('rig', 'Box Rig has not reported its position')
		const point = target.map(v => Number(v.toFixed(3))).join(', ')
		const aim = aimRigAxes(rig.mpos, [...target], project.addsub.calibration)
		if (!aim) throw new SequenceError('rig', `The camera can't be aimed at (${point}) from here`)
		rigLimitsCheck(aim)
		message.value = `Aiming the camera at (${point})`
		try {
			await rig.moveTo(aim, {feed: project.addsub.rigFeed})
			message.value = null
		} catch (e) {
			message.value = e instanceof Error ? e.message : String(e)
			throw e
		}
	}

	/**
	 * Put the lighting this shot was taken with on the LED wall: the pixels
	 * recorded at capture, verbatim. Turns the work light off; the wall keeps
	 * showing it until a lighting mode changes.
	 */
	async function recallLed(frame: number, layer: number) {
		const wall = project.shot(frame, layer)?.led?.wall
		if (!wall) throw new SequenceError('led', `Frame ${frame}: no lighting recorded`)
		if (!led.connected) throw new SequenceError('led', 'LED wall is not connected')
		led.leaveWorkLight()
		try {
			await led.showWallRecord(wall)
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
		if (!project.layers[layer]) throw new SequenceError('cut', `No layer ${layer}`)
		const path = cutFilePath(project, layer, frame, file.name)
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

	/**
	 * A layer's folder changed (renamed, or the project moved to layer
	 * folders): bring its attached G-code along and point the records at the
	 * new paths. Any record (of any layer) whose file was under the old folder
	 * follows too; a file that is already gone keeps its record untouched.
	 */
	project.onLayerFolderChanged(async ({layerId, from, to}) => {
		const targetDir = layerGcodeDir(to)
		const oldPrefix = from === null ? `${CUTS_DIR}/${layerId}/` : `${from}/`
		for (const [owner, table] of Object.entries(project.addsub.cuts)) {
			for (const [frame, cut] of Object.entries(table)) {
				if (cut.source !== 'file') continue
				let next: string | undefined
				if (owner === layerId) next = `${targetDir}/${basenameOf(cut.file)}`
				else if (cut.file.startsWith(oldPrefix)) next = `${to}/${cut.file.slice(oldPrefix.length)}`
				if (!next || next === cut.file) continue
				try {
					await project.moveProjectFile(cut.file, next)
				} catch {
					continue
				}
				table[Number(frame)] = {...cut, file: next}
			}
		}
		// Files nobody records any more (detached, superseded) go along too, so
		// the old folder can be removed.
		if (from === null) {
			const stray = `${CUTS_DIR}/${layerId}`
			for (const name of await project.listProjectFiles(stray)) {
				await project.moveProjectFile(`${stray}/${name}`, `${targetDir}/${name}`).catch(() => {})
			}
		}
	})

	/** Detach a dropped file from a frame (the previz cut, if any, applies again). */
	async function removeCut(frame: number, layer: number) {
		const cut = cutFor(project, frame, layer)
		if (!cut) return
		setCut(project, frame, layer, null)
		if (cut.source === 'file') await project.removeProjectFile(cut.file).catch(() => {})
	}

	//--------------------------------------------------------------------------
	// Presets: G-code kept in the project (`gcode/_presets/`) to attach to any
	// frame later. Attaching copies the file, so a frame's cut never depends
	// on the preset still being there.

	/** Keep a G-code file as a preset. A preset of the same name is replaced. */
	async function addCutPreset(file: File): Promise<CutPreset> {
		const path = cutPresetPath(file.name)
		await project.writeProjectFile(path, file)
		const addedAt = Date.now()
		const text = await file.text()
		const tp = await parseToolpathCached(`${path}@${addedAt}`, async () => text)
		const preset: CutPreset = {
			file: path,
			name: file.name,
			addedAt,
			lines: prepareGCode(text).length,
			estimatedSec: tp?.seconds,
		}
		const list = (project.addsub.cutPresets ?? []).filter(p => p.file !== path)
		project.addsub.cutPresets = [...list, preset]
		return preset
	}

	/** Delete a preset and its file. Frames it was attached to keep their copy. */
	async function removeCutPreset(preset: CutPreset) {
		project.addsub.cutPresets = (project.addsub.cutPresets ?? []).filter(p => p.file !== preset.file)
		await project.removeProjectFile(preset.file).catch(() => {})
	}

	/** Attach a preset to a frame, as if its file had been dropped on the cell. */
	async function applyCutPreset(preset: CutPreset, frame: number, layer: number): Promise<FrameCut> {
		if (cutting.value?.frame === frame && cutting.value.layer === layer) {
			throw new SequenceError('cut', `Frame ${frame} is being cut`)
		}
		const root = project.directoryHandle
		if (!root) throw new SequenceError('cut', 'Project folder is not available')
		let text: string
		try {
			text = await readProjectText(root, preset.file)
		} catch {
			throw new SequenceError('cut', `Preset file missing: ${preset.file}`)
		}
		return attachCutFile(frame, layer, new File([text], preset.name, {type: 'text/plain'}))
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
	 * Stream the frame's G-code to the mill as it is — in whatever work zero
	 * is set on the machine, like any sender would — and record the run.
	 * Shared by the sequence's `cut` step and the stand-alone Cut button.
	 */
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
		// Shooting happens with the mill at MILL_SHOOT_POSITION (work
		// coordinates). Remember where it was, to return to after the shot.
		const {x, y, z} = mill.wpos
		if (
			!project.addsub.sequence?.returnPosition &&
			x !== undefined &&
			y !== undefined &&
			z !== undefined
		) {
			patchProgress({returnPosition: {x, y, z}})
		}
		const to = MILL_SHOOT_POSITION
		message.value = `Moving mill to shoot position X ${to.x} Y ${to.y} Z ${to.z}`
		// X/Y first — the head is up after a cut — then lower Z, so the tool
		// never descends over the block.
		await mill.send(`G90 G0 X${to.x} Y${to.y}`)
		await mill.waitIdle({signal: signal()})
		await mill.send(`G90 G0 Z${to.z}`)
		await mill.waitIdle({signal: signal()})
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

	/**
	 * The wall for the frame: its plan's recorded wall (plan.led, from
	 * Houdini's Send Plans) put back pixel for pixel; otherwise whatever mode
	 * is on (faces, live feed, a manual fill) — the step just takes the work
	 * light off and waits for the latch. Without the wall there is nothing
	 * of this frame's to set: shoot with it as it is.
	 */
	async function stepLed() {
		if (!led.connected) return
		led.leaveWorkLight()
		const planned = effectivePlan(project.captureShot.frame, project.captureShot.layer)?.plan.led
		try {
			if (planned) await led.showWallRecord(planned.file)
			else await led.ensureShown()
		} catch (e) {
			warn(`LED: ${e instanceof Error ? e.message : String(e)}`)
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

	function layerFor(kind: 'main' | 'park'): number {
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
		}
	}

	async function stepCapture(frame: number, kind: 'main' | 'park', src?: FrameSource) {
		if (!capture) throw new SequenceError('capture', 'No capture handler registered')
		message.value = kind === 'park' ? 'Park reference shot' : `Capturing frame ${frame}`
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
		await rig.moveTo(rigWork.toMachine(parkPose), {feed: rigFeed, signal: signal()})
		await stepSettle()
		await stepCapture(frame, 'park')
	}

	async function stepRetract(frame: number) {
		if (!mill.connected) {
			if (millNeeded(frame)) throw new SequenceError('retract', 'Mill is not connected')
			return
		}
		const back = project.addsub.sequence?.returnPosition
		if (!back) {
			warn('No return position recorded — mill left at the shoot position')
			return
		}
		message.value = 'Returning mill'
		// The way it came: Z first (back up out of the shoot height), then X/Y.
		if (back.z !== undefined) {
			await mill.send(`G90 G0 Z${back.z}`)
			await mill.waitIdle({signal: signal()})
		}
		const xy = `X${back.x}` + (back.y !== undefined ? ` Y${back.y}` : '')
		await mill.send(`G90 G0 ${xy}`)
		await mill.waitIdle({signal: signal()})
	}

	async function runStep(step: SequenceStep, frame: number, src: FrameSource) {
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
				return stepLed()
			case 'settle':
				return stepSettle()
			case 'capture':
				return stepCapture(frame, 'main', src)
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
		range?: [number, number]
	) {
		const steps = SEQUENCE_STEPS
		const saved = project.addsub.sequence
		const resume = saved && saved.frame === frame && saved.status !== 'done'
		const known = (s: SequenceStep) => steps.includes(s)
		let done = resume ? saved.done.filter(known) : []
		const start = fromStep ?? (resume && known(saved.step) ? saved.step : steps[0])
		if (fromStep) {
			done = done.filter(s => steps.indexOf(s) < steps.indexOf(fromStep))
		}

		setProgress({
			range,
			frame,
			step: start,
			done,
			status: 'running',
			returnPosition: resume ? saved.returnPosition : undefined,
			updatedAt: Date.now(),
		})

		const src = resolveSource(frame)
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
						tasks.push(runStep(s, frame, src).then(() => markDone(s)))
					}
				}
				const results = await Promise.allSettled(tasks)
				const failed = results.find(r => r.status === 'rejected')
				if (failed && failed.status === 'rejected') throw failed.reason
				continue
			}
			await runStep(step, frame, src)
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
			/** Inclusive range of timeline frames to run. */
			range?: [number, number]
		} = {}
	) {
		if (running.value) return
		running.value = true
		continuous.value = opts.continuous ?? false
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
				await runFrame(frame, fromStep, range)
				fromStep = undefined
				// Each shot drags the out-point to the capture cursor; a run over
				// in → out keeps the range it was given.
				if (range) project.$patch({previewRange: [range[0], range[1]]})
				if (!continuous.value || stopRequested.value) break
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
			message.value = ended ?? (continuous.value ? 'Stopped' : 'Done')
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
			if (range) project.$patch({previewRange: [range[0], range[1]]})
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
			range: p.range,
			continuous: !!p.range,
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
		resume,
		stop,
		estop,
		pauseAfterFrame,
		clearProgress,
		gcodeFor,
		toolpathFor,
		gcodeStamp,
		attachCutFile,
		removeCut,
		addCutPreset,
		removeCutPreset,
		applyCutPreset,
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
		aimRigAt,
		recallLed,
		rigTargetForShot,
		steps: SEQUENCE_STEPS,
	}
})
