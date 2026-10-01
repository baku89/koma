/**
 * Per-frame shooting plan (ADDSUB.md §13): what a frame *should* be shot with,
 * kept in koma's own project data, per layer and timeline frame. A plan is
 * what the shot sequence moves to before capturing; seeking the timeline never
 * moves anything — the rig only goes to a plan when the operator (or the
 * sequence) explicitly asks.
 *
 * Fields are all optional and override the previz frame field by field
 * (`resolveSource` in the sequence store merges them), so a plan can pin just
 * the rig axes and leave lighting / exposure to previz.
 *
 * Pure helpers here (no store), so the timeline can show planned frames
 * without pulling in the machine stores.
 */

import {quat, vec3} from 'linearly'
import type {ConfigType} from 'tethr'

import type {Project} from '@/stores/project'
import {AXES, type AxesPosition} from '@/utils/fluidnc'

import type {CameraPose} from './kinematics'

export interface FramePlan {
	/**
	 * Rig axes (machine coords) to move to before the shot. Partial: axes left
	 * out keep their current position. Takes precedence over `camera`.
	 */
	rig?: AxesPosition
	/** Camera pose in film coords (mm + quat), solved to rig axes at shoot time. */
	camera?: CameraPose
	/** Exposure etc., applied to the camera before the shot. */
	cameraConfigs?: Partial<ConfigType>
	note?: string
}

/** layer id → timeline frame → plan. Sparse. */
export type PlanTable = Record<string, Record<number, FramePlan>>

/**
 * Camera configs a plan records from the live camera ("Set plan from
 * current") and re-applies with "Go to plan". Only what varies per frame on
 * this set: exposure mode is always M (the default shoot condition enforces
 * it), the lens is a prime, and white balance / exposure comp / colour
 * temperature stay fixed for the whole film.
 */
export const PLAN_CAMERA_CONFIG_NAMES = ['aperture', 'shutterSpeed', 'iso', 'focusDistance'] as const

export type PlanCameraConfigName = (typeof PLAN_CAMERA_CONFIG_NAMES)[number]

/**
 * Configs the shoot condition compares against the plan. focusDistance is
 * applied but not checked: cameras report it coarsely and can't always land
 * on the exact value, which would block every shot.
 */
export const PLAN_CHECKED_CONFIG_NAMES = PLAN_CAMERA_CONFIG_NAMES.filter(
	n => n !== 'focusDistance'
)

/**
 * The plan in force at a frame: the frame's own plan, or one interpolated
 * between the nearest planned frames on either side (a "planned koma" the
 * operator never typed — the timeline shows it dimmer, the sequence shoots it
 * like any other).
 */
export interface EffectivePlan {
	plan: FramePlan
	kind: 'explicit' | 'interpolated'
	/** For `interpolated`: the planned frames it was derived from. */
	from?: number
	to?: number
}

function lerp(a: number, b: number, t: number) {
	return a + (b - a) * t
}

/**
 * Interpolate between two plans (`t` 0→1). Rig axes present in both are
 * interpolated linearly, an axis in only one is held; a camera pose in both
 * is lerp/slerp'ed; camera configs and the note are held from `a` (exposure
 * steps, it doesn't glide).
 */
export function interpolatePlan(a: FramePlan, b: FramePlan, t: number): FramePlan {
	const out: FramePlan = {}
	if (a.rig || b.rig) {
		const rig: AxesPosition = {}
		for (const axis of AXES) {
			const va = a.rig?.[axis]
			const vb = b.rig?.[axis]
			if (va === undefined && vb === undefined) continue
			rig[axis] = va === undefined ? vb! : vb === undefined ? va : lerp(va, vb, t)
		}
		out.rig = rig
	} else if (a.camera && b.camera) {
		out.camera = {
			position: vec3.lerp(a.camera.position, b.camera.position, t),
			rotation: quat.slerp(a.camera.rotation, b.camera.rotation, t),
		}
	} else if (a.camera) {
		out.camera = a.camera
	}
	if (a.cameraConfigs) out.cameraConfigs = a.cameraConfigs
	return out
}

export function effectivePlanFor(
	project: Project,
	frame: number,
	layer: number
): EffectivePlan | null {
	const own = planFor(project, frame, layer)
	if (own) return {plan: own, kind: 'explicit'}
	const keys = plannedFrames(project, layer)
	if (keys.length < 2) return null
	let prev = -1
	let next = -1
	for (const k of keys) {
		if (k < frame) prev = k
		else if (k > frame) {
			next = k
			break
		}
	}
	if (prev < 0 || next < 0) return null
	const a = planFor(project, prev, layer)!
	const b = planFor(project, next, layer)!
	return {
		plan: interpolatePlan(a, b, (frame - prev) / (next - prev)),
		kind: 'interpolated',
		from: prev,
		to: next,
	}
}

/** Frames strictly between consecutive planned frames of a layer, ascending. */
export function interpolatedFrames(project: Project, layer: number): number[] {
	const keys = plannedFrames(project, layer)
	const out: number[] = []
	for (let i = 1; i < keys.length; i++) {
		for (let f = keys[i - 1] + 1; f < keys[i]; f++) out.push(f)
	}
	return out
}

/** Short human description of a plan ("X 12.0 · Y −30.0 · f/8 1/60"). */
export function formatPlan(plan: FramePlan, digits = 1): string {
	const parts: string[] = []
	if (plan.rig) parts.push(formatAxes(plan.rig, digits))
	else if (plan.camera) parts.push(`camera ${plan.camera.position.map(v => v.toFixed(digits)).join(', ')}`)
	const c = plan.cameraConfigs
	if (c) {
		const cam: string[] = []
		if (c.aperture !== undefined) cam.push(`f/${c.aperture}`)
		if (c.shutterSpeed !== undefined) cam.push(String(c.shutterSpeed))
		if (c.iso !== undefined) cam.push(`ISO ${c.iso}`)
		if (c.focusDistance !== undefined) cam.push(`focus ${c.focusDistance}`)
		parts.push(cam.length ? cam.join(' ') : 'camera configs')
	}
	return parts.join(' · ') || 'empty'
}

export function planFor(
	project: Project,
	frame: number,
	layer: number
): FramePlan | undefined {
	const id = project.layers[layer]?.id
	if (id === undefined) return undefined
	return project.addsub.plan[id]?.[frame]
}

/** Replace (or with `null`, remove) the plan for one frame of a layer. */
export function setPlan(
	project: Project,
	frame: number,
	layer: number,
	plan: FramePlan | null
) {
	const id = project.layers[layer]?.id
	if (id === undefined) return
	const table = project.addsub.plan
	if (plan === null) {
		if (!table[id]) return
		delete table[id][frame]
		if (Object.keys(table[id]).length === 0) delete table[id]
		return
	}
	if (!table[id]) table[id] = {}
	table[id][frame] = plan
}

/** Frames of a layer that have a plan, ascending. */
export function plannedFrames(project: Project, layer: number): number[] {
	const id = project.layers[layer]?.id
	if (id === undefined) return []
	return Object.keys(project.addsub.plan[id] ?? {})
		.map(Number)
		.sort((a, b) => a - b)
}

/**
 * A straight rig move: `count` frames from `from` to `to` (inclusive at both
 * ends, linear in every axis given). Axes present in only one end are held at
 * that value.
 */
export function linearRigPlan(
	from: AxesPosition,
	to: AxesPosition,
	count: number
): FramePlan[] {
	const n = Math.max(1, Math.round(count))
	const out: FramePlan[] = []
	for (let i = 0; i < n; i++) {
		const t = n === 1 ? 1 : i / (n - 1)
		const rig: AxesPosition = {}
		for (const axis of AXES) {
			const a = from[axis]
			const b = to[axis]
			if (a === undefined && b === undefined) continue
			const va = a ?? b!
			const vb = b ?? a!
			rig[axis] = va + (vb - va) * t
		}
		out.push({rig})
	}
	return out
}

/** "X 12.0 · Y −30.0" for tooltips and the panel. */
export function formatAxes(axes: AxesPosition, digits = 1): string {
	return AXES.filter(a => axes[a] !== undefined)
		.map(a => `${a.toUpperCase()} ${axes[a]!.toFixed(digits)}`)
		.join(' · ')
}
