/**
 * The distortion calibration (directions × radii), as the operator runs it
 * (rigDistortion.ts has the maths, rigWork.ts applies the result):
 *
 *   Go      send the rig to a point's nominal pose, uncorrected — the pose
 *           the controller is asked for is the pose we want the camera at.
 *   Record  the marker looks right now: keep where the controller says the
 *           rig is against the nominal pose.
 *   Clear   forget a point.
 *
 * The samples live in the project (`addsub.rigDistortion`); the reticle
 * switch is this machine's.
 */

import {defineStore} from 'pinia'
import {useTweeq} from 'tweeq'
import {computed, ref} from 'vue'

import {useProjectStore} from '@/stores/project'
import type {AxesPosition} from '@/utils/fluidnc'

import {
	axisDeltas,
	DISTORTION_DIRECTIONS,
	type DistortionPoint,
	distortionPoints,
	type DistortionSample,
	nominalAxes,
	type RigAxes,
} from '../rigDistortion'
import {useRigStore} from './machines'
import {useRigWorkStore} from './rigWork'
import {useSequenceStore} from './sequence'

export interface DistortionPointStatus {
	point: DistortionPoint
	/** The pose Go sends now (calibrated = work axes). */
	nominal: RigAxes
	sample: DistortionSample | null
	/** Actual − nominal per axis, for reading. */
	deltas: RigAxes | null
	/** The sample was recorded against a different nominal (base / radius / pupil changed since). */
	stale: boolean
	/** The rig stands at the nominal pose now (within the plan tolerance), uncorrected. */
	atNominal: boolean
}

const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps

export const useRigDistortionStore = defineStore('addsub:rigDistortion', () => {
	const Tq = useTweeq()
	const project = useProjectStore()
	const rig = useRigStore()
	const rigWork = useRigWorkStore()
	const sequence = useSequenceStore()

	const data = computed(() => project.addsub.rigDistortion)

	/** Draw the marker reticle on the Preview. */
	const reticle = Tq.config.ref('addsub.rigDistortion.reticle', false)

	/** The point last sent to with Go (its reticle is the one to match). */
	const activePointId = ref<string | null>(null)

	const message = ref<string | null>(null)

	function nominalFor(point: DistortionPoint): RigAxes {
		return nominalAxes(point, data.value, project.addsub.calibration)
	}

	const points = computed<DistortionPointStatus[]>(() => {
		const tol = project.addsub.planTolerance
		const now = rig.connected && rig.mpos.x !== undefined ? rigWork.toWork(rig.mpos) : null
		return distortionPoints(data.value).map(point => {
			const nominal = nominalFor(point)
			const sample = data.value.samples[point.id] ?? null
			const stale =
				!!sample &&
				(['x', 'y', 'z', 'a', 'b', 'c'] as const).some(
					axis => !near(sample.nominal[axis], nominal[axis], 0.01)
				)
			const atNominal =
				!!now &&
				(['x', 'y', 'z'] as const).every(axis => near(now[axis] ?? NaN, nominal[axis], tol.linear)) &&
				(['a', 'b', 'c'] as const).every(axis => near(now[axis] ?? NaN, nominal[axis], tol.rotary))
			return {point, nominal, sample, deltas: sample ? axisDeltas(sample) : null, stale, atNominal}
		})
	})

	const activePoint = computed(() => points.value.find(p => p.point.id === activePointId.value) ?? null)

	/** Recorded points that are no longer asked for (direction or radius dropped). */
	const orphanSamples = computed(() => {
		const asked = new Set(points.value.map(p => p.point.id))
		return Object.keys(data.value.samples).filter(id => !!data.value.samples[id] && !asked.has(id))
	})

	/** A list as typed: "400, 250" → [400, 250] (finite, distinct, in that order). */
	function parseList(text: string, opts: {min?: number} = {}): number[] {
		const seen = new Set<number>()
		const out: number[] = []
		for (const part of text.split(/[\s,;/]+/)) {
			const v = Number(part)
			if (!part || !Number.isFinite(v) || (opts.min !== undefined && v < opts.min) || seen.has(v)) continue
			seen.add(v)
			out.push(Math.round(v * 10) / 10)
		}
		return out
	}

	/** Pupil-to-base radii, mm (positive). */
	function setRadii(text: string) {
		const radii = parseList(text, {min: 1})
		if (radii.length > 0) data.value.radii = radii
	}

	/** Pans to calibrate the straight-down point at, degrees. */
	function setTopPans(text: string) {
		const pans = parseList(text)
		if (pans.length > 0) data.value.topPans = pans
	}

	/** Rolls to calibrate the other points at, degrees. */
	function setRolls(text: string) {
		const rolls = parseList(text)
		if (rolls.length > 0) data.value.rolls = rolls
	}

	function setDirection(id: string, on: boolean) {
		const next = DISTORTION_DIRECTIONS.map(d => d.id).filter(d => (d === id ? on : data.value.directions.includes(d)))
		if (next.length > 0) data.value.directions = next
	}

	const canMove = computed(() => rig.connected && !rig.busy && !sequence.running && rig.state === 'Idle')

	function limitsCheck(target: AxesPosition) {
		for (const [axis, range] of Object.entries(project.addsub.rigLimits)) {
			const v = target[axis as keyof AxesPosition]
			if (!range || v === undefined) continue
			if (v < range[0] || v > range[1]) {
				const work = (m: number) => rigWork.axisToWork(axis as 'x', m).toFixed(1)
				throw new Error(
					`${axis.toUpperCase()} = ${work(v)} is outside the travel [${work(range[0])}, ${work(range[1])}]`
				)
			}
		}
	}

	/**
	 * Send the rig to a point's nominal pose, *without* the correction: the
	 * controller is asked for the ideal pose, and whatever is wrong with the
	 * picture there is the distortion to record.
	 */
	async function goTo(id: string) {
		const p = points.value.find(s => s.point.id === id)
		if (!p) throw new Error(`no calibration point "${id}"`)
		if (sequence.running) throw new Error('Sequence is running')
		if (!rig.connected) throw new Error('Box Rig is not connected')
		const target = rigWork.toMachine(p.nominal)
		limitsCheck(target)
		activePointId.value = id
		reticle.value = true
		message.value = `Moving to ${p.point.label}…`
		try {
			await rig.moveTo(target, {feed: project.addsub.rigFeed})
			message.value = `At ${p.point.label} (uncorrected). Jog until the marker is right, then Record.`
		} catch (e) {
			message.value = e instanceof Error ? e.message : String(e)
			throw e
		}
	}

	/** Keep where the rig is now as the truth for a point. */
	function record(id: string) {
		const p = points.value.find(s => s.point.id === id)
		if (!p) throw new Error(`no calibration point "${id}"`)
		if (!rig.connected || rig.mpos.x === undefined) throw new Error('Box Rig is not reporting its position')
		const m = rig.mpos
		const actual = rigWork.toWork({x: m.x, y: m.y, z: m.z, a: m.a, b: m.b, c: m.c}) as RigAxes
		data.value.samples = {...data.value.samples, [id]: {nominal: p.nominal, actual, at: Date.now()}}
		const d = axisDeltas({nominal: p.nominal, actual, at: 0})
		message.value = `${p.point.label} recorded: Δ ${d.x} ${d.y} ${d.z} mm · ${d.a} ${d.b} ${d.c}°`
	}

	function clear(id?: string) {
		if (id === undefined) {
			data.value.samples = {}
			message.value = 'All points cleared'
			return
		}
		const next = {...data.value.samples}
		delete next[id]
		data.value.samples = next
	}

	return {
		data,
		reticle,
		activePointId,
		activePoint,
		points,
		orphanSamples,
		canMove,
		message,
		nominalFor,
		setRadii,
		setTopPans,
		setRolls,
		setDirection,
		goTo,
		record,
		clear,
	}
})
