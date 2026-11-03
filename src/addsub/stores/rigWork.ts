/**
 * The Box Rig's three coordinate frames.
 *
 *   Machine     the controller's MPos: the status reports, the travel
 *               limits, every move koma sends (G53).
 *   Work        MPos − WCO (G54: the origin is the centre of the work's
 *               bottom face, the rotary zeros are the head looking straight).
 *               What the controller calls the pose, and what shot records
 *               and the park pose store — a record of what was sent.
 *   Calibrated  where the camera really is, once the rig's distortion (sag,
 *               twist — rigDistortion.ts, fitted from the multi-point
 *               calibration) is taken out. Plans, previz, Houdini, the 3D
 *               view and the LED wall live here; without a calibration it is
 *               the work frame.
 *
 * The work origin is the world origin: the controller's work coordinate
 * offset (WCO) *is* the calibration's `rigOffset` (X/Y/Z) and `rotaryZero`
 * (A/B/C). While the rig is connected the project follows what the
 * controller reports; offline the last values seen keep the numbers the same.
 *
 * Moves koma computes go Calibrated → `fromCalibrated` → Machine, just before
 * they are sent; the controller's position comes back through `toCalibrated`.
 */

import {defineStore} from 'pinia'
import {computed, nextTick, watch} from 'vue'

import {useProjectStore} from '@/stores/project'
import type {AxesPosition, Axis} from '@/utils/fluidnc'

import {shiftStoredRigAxes} from '../projectData'
import {
	calibratedToWork,
	completeAxes,
	deltaAt,
	type RigAxes,
	solveDistortion,
	workToCalibrated,
	ZERO_AXES,
} from '../rigDistortion'
import {useRigStore} from './machines'

/** Positions are reported to 3 decimals. */
const EPSILON = 0.0005

/** Kill the float noise of adding / subtracting an offset. */
const round = (v: number) => Math.round(v * 1000) / 1000

export const useRigWorkStore = defineStore('addsub:rigWork', () => {
	const project = useProjectStore()
	const rig = useRigStore()

	/** Machine position of the work origin, per axis. */
	const offset = computed<Required<Pick<AxesPosition, 'x' | 'y' | 'z' | 'a' | 'b' | 'c'>>>(() => {
		const {rigOffset, rotaryZero} = project.addsub.calibration
		return {x: rigOffset[0], y: rigOffset[1], z: rigOffset[2], ...rotaryZero}
	})

	function axisToWork(axis: Axis, machine: number) {
		return round(machine - ((offset.value as AxesPosition)[axis] ?? 0))
	}

	function axisToMachine(axis: Axis, work: number) {
		return round(work + ((offset.value as AxesPosition)[axis] ?? 0))
	}

	function convert(axes: AxesPosition, fn: (axis: Axis, v: number) => number) {
		const out: AxesPosition = {}
		for (const [axis, v] of Object.entries(axes) as [Axis, number | undefined][]) {
			if (v !== undefined) out[axis] = fn(axis, v)
		}
		return out
	}

	/** Machine → work coordinates (axes left out stay left out). */
	const toWork = (machine: AxesPosition) => convert(machine, axisToWork)
	/** Work → machine coordinates. */
	const toMachine = (work: AxesPosition) => convert(work, axisToMachine)

	// Follow the controller's work offset. Not while a project is loading
	// (it would be overwritten), nor for a board that hasn't said it is the rig.
	watch(
		() => [rig.wco, rig.unidentified, project.isOpening] as const,
		([wco, unidentified, opening]) => {
			if (!wco || unidentified || opening) return
			const cal = project.addsub.calibration
			const now = offset.value
			// A file converted from machine coordinates with an offset the
			// controller never confirmed: keep its axes where they physically
			// were under the real offset (machine = work + offset).
			if (project.addsub.rigRebase) {
				const delta: AxesPosition = {}
				for (const axis of ['x', 'y', 'z', 'a', 'b', 'c'] as const) {
					const v = wco[axis]
					if (v !== undefined && Math.abs(now[axis] - v) > EPSILON) delta[axis] = now[axis] - v
				}
				if (Object.keys(delta).length > 0) {
					shiftStoredRigAxes(project, delta)
					// Undo would bring back axes for the old offset.
					nextTick(() => project.history.clear())
				}
				project.addsub.rigRebase = false
			}
			const differs = (axis: Axis) => {
				const v = wco[axis]
				return v !== undefined && Math.abs(v - ((now as AxesPosition)[axis] ?? 0)) > EPSILON
			}
			if (differs('x') || differs('y') || differs('z')) {
				cal.rigOffset = [wco.x ?? now.x, wco.y ?? now.y, wco.z ?? now.z]
			}
			if (differs('a') || differs('b') || differs('c')) {
				cal.rotaryZero = {a: wco.a ?? now.a, b: wco.b ?? now.b, c: wco.c ?? now.c}
			}
		},
		{immediate: true}
	)

	//--------------------------------------------------------------------------
	// Calibrated frame (rigDistortion.ts)

	/** The fitted error field; null with no samples or the correction off. */
	const field = computed(() => {
		const d = project.addsub.rigDistortion
		if (!d?.enabled) return null
		const samples = Object.values(d.samples ?? {}).filter(s => !!s)
		if (samples.length === 0) return null
		return solveDistortion(samples, project.addsub.calibration)
	})

	/** A correction is in force (Calibrated differs from Work). */
	const corrected = computed(() => field.value !== null)

	/** Work axes → calibrated. Axes left out count as 0 for the pose and are left out of the result. */
	function workToCal(work: AxesPosition): AxesPosition {
		if (!field.value) return work
		const full = workToCalibrated(completeAxes(work, ZERO_AXES), field.value, project.addsub.calibration)
		return pick(full, work)
	}

	/** Machine axes → calibrated (the given axes). */
	const toCalibrated = (machine: AxesPosition) => workToCal(toWork(machine))

	/** Where the rig really is now, all six axes; null while it reports nothing. */
	const calibratedNow = computed<RigAxes | null>(() => {
		const m = rig.mpos
		if (m.x === undefined) return null
		return completeAxes(toCalibrated(m), ZERO_AXES)
	})

	/**
	 * Calibrated axes → machine axes to send. The correction depends on the
	 * whole pose, so axes left out are taken from where the rig is now (its
	 * calibrated pose) to compute it — and left out of the result, so a move
	 * of some axes moves only those.
	 */
	function fromCalibrated(cal: AxesPosition): AxesPosition {
		if (!field.value) return toMachine(cal)
		const full = completeAxes(cal, calibratedNow.value ?? ZERO_AXES)
		const work = calibratedToWork(full, field.value, project.addsub.calibration)
		return pick(toMachine(work), cal)
	}

	/**
	 * Run a machine-coordinate kinematics function (aimRigAxes,
	 * rotateAboutPupil, orbitRigAxes…) on the rig's *true* pose: the current
	 * axes are read in the calibrated frame, dressed as machine coordinates
	 * for the function, and its result is corrected back to real machine
	 * coordinates. Without a calibration it is `fn(rig.mpos)`. Null while the
	 * rig reports no position.
	 */
	function onTruePose(fn: (axes: RigAxes) => AxesPosition): AxesPosition | null {
		const now = calibratedNow.value
		if (!now) return null
		const result = fn(toMachine(now) as RigAxes)
		return fromCalibrated(toWork(result))
	}

	/** The correction in force at the rig's position now (world mm / deg). */
	const correctionNow = computed(() => {
		const now = calibratedNow.value
		if (!now || !field.value) return null
		const signs = project.addsub.calibration.rotarySigns
		return deltaAt(field.value, [now.x, now.y, now.z], now.b * signs.b, now.c * signs.c)
	})

	/** `full` restricted to the axes `like` has. */
	function pick(full: AxesPosition, like: AxesPosition): AxesPosition {
		const out: AxesPosition = {}
		for (const axis of Object.keys(like) as Axis[]) {
			if (like[axis] !== undefined) out[axis] = full[axis]
		}
		return out
	}

	return {
		offset,
		axisToWork,
		axisToMachine,
		toWork,
		toMachine,
		field,
		corrected,
		workToCalibrated: workToCal,
		toCalibrated,
		calibratedNow,
		fromCalibrated,
		onTruePose,
		correctionNow,
	}
})
