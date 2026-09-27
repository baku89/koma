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
