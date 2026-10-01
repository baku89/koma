/**
 * addsub's inbox ops (stores/inbox.ts): how a patch dropped into the
 * project's `_inbox/` attaches cuts and sets plans.
 *
 *   {"op": "setCut", "layer": "main", "frame": 41,
 *    "file": "gcode/main/0041_face Z-0.5.nc", "name": "face Z-0.5.nc"}
 *       The file must already be in the project folder. Conflict: the frame
 *       already has an attached file.
 *   {"op": "clearCut", "layer": "main", "frame": 41}
 *       Forgets the record; the file stays.
 *   {"op": "setPlan", "layer": "main", "frame": 41,
 *    "plan": {"rig": {"x": 0, "y": -542.5}, "cameraConfigs": {"iso": 100}}}
 *       Conflict: the frame already has a plan of its own.
 *   {"op": "clearPlan", "layer": "main", "frame": 41}
 *
 * `layer` is the layer id (project.layers[i].id), `frame` the timeline frame.
 */

import {cloneDeep} from 'lodash-es'

import {InboxConflict, type InboxOp, registerInboxOp} from '@/stores/inbox'
import {useProjectStore} from '@/stores/project'
import {AXES, prepareGCode} from '@/utils/fluidnc'
import {parseToolpathCached} from '@/utils/fluidnc/toolpathParser'

import {cutFor, isGcodeFilename, readProjectText, setCut} from './cuts'
import {type FramePlan, planFor, setPlan} from './plan'
import type {FrameCut} from './projectData'
import {useSequenceStore} from './stores/sequence'

export function setupAddsubInbox() {
	const project = useProjectStore()
	const sequence = useSequenceStore()

	/** The op's cell: layer index and frame, validated. */
	function cell(op: InboxOp): {layer: number; frame: number} {
		const layer = project.layers.findIndex(l => l.id === op.layer)
		if (layer < 0) {
			throw new Error(
				`no layer with id "${String(op.layer)}" (have: ${project.layers.map(l => l.id).join(', ')})`
			)
		}
		const frame = op.frame
		if (typeof frame !== 'number' || !Number.isInteger(frame) || frame < 0) {
			throw new Error(`"frame" must be a non-negative integer, got ${JSON.stringify(frame)}`)
		}
		return {layer, frame}
	}

	function refuseWhileCutting(layer: number, frame: number) {
		const c = sequence.cutting
		if (c && c.frame === frame && c.layer === layer) {
			throw new Error(`frame ${frame} is being cut right now`)
		}
	}

	registerInboxOp('setCut', async (op, ctx) => {
		const {layer, frame} = cell(op)
		refuseWhileCutting(layer, frame)
		const path = op.file
		if (typeof path !== 'string' || !isGcodeFilename(path)) {
			throw new Error(`"file" must be a G-code path in the project, got ${JSON.stringify(path)}`)
		}
		let text: string
		try {
			text = await readProjectText(ctx.root, path)
		} catch {
			throw new Error(`file not found in the project: ${path}`)
		}
		const lines = prepareGCode(text).length
		if (lines === 0) throw new Error(`${path} has no G-code lines`)
		const previous = cutFor(project, frame, layer)
		if (previous?.source === 'file' && !ctx.overwrite) {
			throw new InboxConflict(`frame ${frame} already has a cut (${previous.name})`)
		}
		const addedAt = Date.now()
		const tp = await parseToolpathCached(`${path}@${addedAt}`, async () => text)
		const cut: FrameCut = {
			source: 'file',
			file: path,
			name: typeof op.name === 'string' ? op.name : path.split('/').pop()!,
			addedAt,
			lines,
			estimatedSec: tp?.seconds,
			run: null,
		}
		return {
			apply: () => {
				setCut(project, frame, layer, cut)
				return cloneDeep(previous) ?? null
			},
		}
	})

	registerInboxOp('clearCut', op => {
		const {layer, frame} = cell(op)
		refuseWhileCutting(layer, frame)
		const previous = cutFor(project, frame, layer)
		return {
			apply: () => {
				setCut(project, frame, layer, null)
				return cloneDeep(previous) ?? null
			},
		}
	})

	registerInboxOp('setPlan', (op, ctx) => {
		const {layer, frame} = cell(op)
		const plan = op.plan as FramePlan | undefined
		if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
			throw new Error('"plan" must be an object')
		}
		if (!plan.rig && !plan.camera && !plan.cameraConfigs) {
			throw new Error('"plan" needs rig, camera or cameraConfigs')
		}
		if (plan.rig) {
			const limits = project.addsub.rigLimits as Record<string, [number, number] | undefined>
			for (const [axis, value] of Object.entries(plan.rig)) {
				if (!(AXES as readonly string[]).includes(axis)) {
					throw new Error(`plan.rig: unknown axis "${axis}"`)
				}
				if (typeof value !== 'number' || !Number.isFinite(value)) {
					throw new Error(`plan.rig.${axis} must be a number`)
				}
				const range = limits[axis]
				if (range && (value < range[0] || value > range[1])) {
					throw new Error(`plan.rig.${axis} = ${value} is outside [${range[0]}, ${range[1]}]`)
				}
			}
		}
		const previous = planFor(project, frame, layer)
		if (previous && !ctx.overwrite) {
			throw new InboxConflict(`frame ${frame} already has a plan`)
		}
		return {
			apply: () => {
				setPlan(project, frame, layer, cloneDeep(plan))
				return cloneDeep(previous) ?? null
			},
		}
	})

	registerInboxOp('clearPlan', op => {
		const {layer, frame} = cell(op)
		const previous = planFor(project, frame, layer)
		return {
			apply: () => {
				setPlan(project, frame, layer, null)
				return cloneDeep(previous) ?? null
			},
		}
	})
}
