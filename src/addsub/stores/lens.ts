/**
 * The lens table (lens.ts) in use: focus in millimetres for the operator,
 * auto focus from the rig's pose, and the file Houdini reads.
 *
 * Focus modes (`project.addsub.focus.mode`): `normalized` leaves the
 * camera's own 0–1 position to Camera Control, `distance` sets it from
 * millimetres through the table, and `target` is auto focus: the camera is
 * kept focused on `focus.target` (work coordinates, mm) — the distance from the
 * head's rotation centre to the target along the optical axis, from the
 * rig's reported pose, through the table to the camera's normalised focus
 * position. The plan's own `focusDistance` is not applied while this is on
 * (stores/sequence.ts), and a shoot condition holds the shutter until the
 * camera has landed on the computed value.
 */

import {useDebounceFn, useThrottleFn} from '@vueuse/core'
import {quat, vec3} from 'linearly'
import {defineStore} from 'pinia'
import {computed, watch} from 'vue'

import {useCameraStore} from '@/stores/camera'
import {useProjectStore} from '@/stores/project'

import {workAxesToCameraPose} from '../kinematics'
import {
	distanceAlongAxis,
	fitLensTable,
	focusForDistance,
	type FocusMode,
	lensAtFocus,
	lensCalibrationJson,
	lensDistanceRange,
	parseLensSheet,
} from '../lens'
import {useRigStore} from './machines'
import {useRigWorkStore} from './rigWork'

/** Houdini reads this from the project folder (ADDSUB.md §13.1). */
export const LENS_CALIBRATION_FILE = 'calibration.json'

/** Normalised focus the camera may be off the auto-focus value and still shoot. */
const FOCUS_TOLERANCE = 0.01
/** Smallest change worth a write to the camera (a PTP round trip). */
const FOCUS_DEADBAND = 0.003

export const useLensStore = defineStore('addsub:lens', () => {
	const project = useProjectStore()
	const camera = useCameraStore()
	const rig = useRigStore()
	const rigWork = useRigWorkStore()

	const calibration = computed(() => project.addsub.lens)

	/** Pupil distance assumed for single-target rows: the calibration's pupil offset. */
	const assumedPupil = computed(() => -project.addsub.calibration.pupilOffset[2])

	const table = computed(() => fitLensTable(calibration.value, assumedPupil.value))
	const hasTable = computed(() => table.value.length >= 2)
	const range = computed(() => lensDistanceRange(table.value))

	//--------------------------------------------------------------------------
	// The camera's focus, in mm

	const focusConfig = computed(() => camera.focusDistance)
	/** Normalised focus position the camera reports (null when unknown). */
	const focusNormalized = computed(() => {
		const v = focusConfig.value?.value
		return typeof v === 'number' ? v : null
	})
	const focusWritable = computed(() => !!camera.tethr && !!focusConfig.value?.writable)

	/** Where the camera is focused, mm from the rotation centre (null without a table). */
	const focusMm = computed(() => {
		if (!hasTable.value || focusNormalized.value === null) return null
		return lensAtFocus(table.value, focusNormalized.value).distance
	})

	/** The lens at the camera's current focus: pinhole focal and pupil (mm). */
	const current = computed(() => {
		if (!hasTable.value || focusNormalized.value === null) return null
		return lensAtFocus(table.value, focusNormalized.value)
	})

	/**
	 * Focal length to show and record: the pinhole focal from the table at
	 * the camera's current focus (mm, 1 decimal). The lens reports its
	 * nameplate 105 whatever the focus; this is what the picture actually is.
	 */
	const focalLength = computed(() => {
		const f = current.value?.focal
		return f === undefined || !Number.isFinite(f) ? null : Math.round(f * 10) / 10
	})

	function normalizedFor(mm: number) {
		return focusForDistance(table.value, mm)
	}

	async function setFocusMm(mm: number) {
		if (mode.value !== 'distance') throw new Error('Switch the focus mode to Distance (mm) first')
		if (!hasTable.value) throw new Error('No lens table — import the measurements first')
		if (!focusWritable.value) throw new Error('The camera does not accept a focus position')
		await focusConfig.value?.set(normalizedFor(mm))
	}

	//--------------------------------------------------------------------------
	// Auto focus

	const mode = computed({
		get: () => project.addsub.focus.mode,
		set: (v: FocusMode) => (project.addsub.focus.mode = v),
	})
	/** Auto focus (the `target` mode) is on. */
	const auto = computed(() => mode.value === 'target')

	/**
	 * Distance from the rotation centre to the focus target along the optical
	 * axis, from the rig's current work-coordinate pose. null while the rig
	 * isn't reporting.
	 */
	const targetDistance = computed(() => {
		if (!rig.connected) return null
		// Work coordinates from the machine position: `rig.wpos` is only the
		// controller's own WPos when it reports one, and falls back to MPos.
		const m = rig.mpos
		if (m.x === undefined) return null
		const w = rigWork.toWork(m)
		const cal = project.addsub.calibration
		const pose = workAxesToCameraPose(w, cal)
		const forward = vec3.transformQuat([0, 0, -1], pose.rotation as quat)
		const centre: vec3 = [w.x ?? 0, w.y ?? 0, w.z ?? 0]
		return distanceAlongAxis(centre, forward, project.addsub.focus.target)
	})

	/** Normalised focus that auto focus wants right now (null = can't tell). */
	const autoNormalized = computed(() => {
		if (!auto.value || !hasTable.value || targetDistance.value === null) return null
		return normalizedFor(targetDistance.value)
	})

	/** The target distance is beyond what the table covers (clamped). */
	const autoOutOfRange = computed(() => {
		const d = targetDistance.value
		const r = range.value
		return auto.value && d !== null && r !== null && (d < r[0] || d > r[1])
	})

	const push = useThrottleFn(
		async (n: number) => {
			const cfg = focusConfig.value
			if (!cfg?.writable || !camera.tethr) return
			const now = typeof cfg.value === 'number' ? cfg.value : null
			if (now !== null && Math.abs(now - n) < FOCUS_DEADBAND) return
			try {
				await cfg.set(n)
			} catch (e) {
				// eslint-disable-next-line no-console
				console.error('[lens] auto focus write failed', e)
			}
		},
		300,
		true
	)

	watch(
		() => [autoNormalized.value, focusWritable.value] as const,
		([n]) => {
			if (n !== null) void push(n)
		},
		{immediate: true}
	)

	/** Shoot conditions (strings, like the sequence's): auto focus must be possible and settled. */
	function alerts(): string[] {
		if (!auto.value) return []
		if (!hasTable.value) return ['Auto focus: no lens table (Camera Control › Lens)']
		if (!camera.tethr) return []
		if (!focusWritable.value) {
			return ['Auto focus: the camera does not accept a focus position (Sigma fp: AF mode)']
		}
		const n = autoNormalized.value
		if (n === null) return ['Auto focus: Box Rig is not reporting its position']
		const out: string[] = []
		const d = targetDistance.value!
		if (autoOutOfRange.value) {
			const [lo, hi] = range.value!
			out.push(`Auto focus: target ${d.toFixed(0)} mm is outside the lens table (${lo.toFixed(0)}–${hi.toFixed(0)} mm)`)
		}
		const now = focusNormalized.value
		if (now === null || Math.abs(now - n) > FOCUS_TOLERANCE) {
			out.push(`Auto focus: camera at ${now === null ? '?' : now.toFixed(3)}, target ${n.toFixed(3)} (${d.toFixed(0)} mm)`)
		}
		return out
	}

	//--------------------------------------------------------------------------
	// Measurements → table, and the file for Houdini

	/** Replace the samples with a pasted / opened sheet. Returns how many rows it had. */
	function importSheet(text: string): number {
		const samples = parseLensSheet(text, calibration.value.farStep)
		if (samples.length === 0) throw new Error('No rows with distance, focus and half width')
		project.addsub.lens.samples = samples
		return samples.length
	}

	function clearSamples() {
		project.addsub.lens.samples = []
	}

	const writeFile = useDebounceFn(async () => {
		if (!project.directoryHandle || !hasTable.value) return
		const json = lensCalibrationJson(calibration.value, table.value)
		try {
			await project.writeProjectFile(
				LENS_CALIBRATION_FILE,
				new Blob([JSON.stringify(json, null, 2)], {type: 'application/json'})
			)
		} catch (e) {
			// eslint-disable-next-line no-console
			console.error(`[lens] could not write ${LENS_CALIBRATION_FILE}`, e)
		}
	}, 1000)

	// Whenever the fitted table changes (new samples, origin, assumed pupil)
	// and the project has a folder, refresh Houdini's copy.
	watch(
		() => [JSON.stringify(table.value), project.directoryHandle] as const,
		() => void writeFile()
	)

	return {
		calibration,
		table,
		hasTable,
		range,
		focusNormalized,
		focusWritable,
		focusMm,
		current,
		focalLength,
		normalizedFor,
		setFocusMm,
		mode,
		auto,
		targetDistance,
		autoNormalized,
		autoOutOfRange,
		alerts,
		importSheet,
		clearSamples,
	}
})
