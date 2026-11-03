/**
 * addsub's read tools (stores/tools.ts): plans, cuts, the machines and the
 * shot sequence as Claude Code sees them. The write side is inboxOps.ts.
 */
import {useProjectStore} from '@/stores/project'
import {useShootAlertsStore} from '@/stores/shootAlerts'
import {registerTool} from '@/stores/tools'

import {cutFor} from './cuts'
import {effectivePlanFor, formatPlan, planFor, plannedFrames} from './plan'
import {useMillStore, useRigStore} from './stores/machines'
import {useRigWorkStore} from './stores/rigWork'
import {useSequenceStore} from './stores/sequence'

const LAYER = {type: 'string', description: 'Layer id (see get_project).'}
const FRAME = {type: 'integer', minimum: 0, description: 'Timeline frame (0-based).'}

export function setupAddsubTools() {
	const project = useProjectStore()
	const sequence = useSequenceStore()
	const mill = useMillStore()
	const rig = useRigStore()
	const rigWork = useRigWorkStore()
	const shootAlerts = useShootAlertsStore()

	function layerIndex(id: unknown): number {
		const index = project.layers.findIndex(l => l.id === id)
		if (index < 0) {
			throw new Error(`no layer with id "${String(id)}" (have: ${project.layers.map(l => l.id).join(', ')})`)
		}
		return index
	}

	function frameArg(value: unknown): number {
		if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
			throw new Error(`"frame" must be a non-negative integer, got ${JSON.stringify(value)}`)
		}
		return value
	}

	registerTool({
		name: 'get_plan',
		description:
			'The plan in effect at a frame of a layer: its own ("explicit") or one interpolated between the planned frames around it ("interpolated", with `from` / `to`). Null when the frame has none. Rig axes are work coordinates (mm, degrees).',
		inputSchema: {type: 'object', properties: {layer: LAYER, frame: FRAME}, required: ['layer', 'frame'], additionalProperties: false},
		execute: args => {
			const layer = layerIndex(args.layer)
			const frame = frameArg(args.frame)
			const e = effectivePlanFor(project, frame, layer)
			if (!e) return null
			return {...e, summary: formatPlan(e.plan, 3)}
		},
	})

	registerTool({
		name: 'list_plans',
		description: 'Every planned frame of a layer (explicit plans only), with a one-line summary and the plan itself.',
		inputSchema: {type: 'object', properties: {layer: LAYER}, required: ['layer'], additionalProperties: false},
		execute: args => {
			const layer = layerIndex(args.layer)
			return plannedFrames(project, layer).map(frame => {
				const plan = planFor(project, frame, layer)!
				return {frame, summary: formatPlan(plan, 3), plan}
			})
		},
	})

	registerTool({
		name: 'get_cut',
		description:
			'The G-code a frame runs before it is shot (a file attached to the cell, else previz) with its record: line count, estimate, the last run (done / stopped / error). Null when the frame has none.',
		inputSchema: {type: 'object', properties: {layer: LAYER, frame: FRAME}, required: ['layer', 'frame'], additionalProperties: false},
		execute: args => {
			const layer = layerIndex(args.layer)
			const frame = frameArg(args.frame)
			const g = sequence.gcodeFor(frame, layer)
			if (!g) return null
			const c = sequence.cutting
			return {
				path: g.path,
				name: g.name,
				source: g.source,
				record: g.cut ?? cutFor(project, frame, layer) ?? null,
				cutting: !!c && c.frame === frame && c.layer === layer,
			}
		},
	})

	registerTool({
		name: 'get_machines',
		description:
			'The Box Rig and the mill right now: connected, FluidNC state, machine / work / calibrated coordinates (the rig\'s plans are in the calibrated frame = work with the distortion taken out; shots record work), alarms; plus the shot sequence (running, step, message, what is being cut) and the shoot alerts that would stop a shot at the capture frame.',
		inputSchema: {type: 'object', properties: {}, additionalProperties: false},
		execute: () => {
			const machine = (m: typeof mill) => ({
				connected: m.connected,
				state: m.state,
				mpos: m.mpos,
				wpos: m.wpos,
				alarm: m.alarm,
				lastError: m.lastError,
				busy: m.busy,
			})
			return {
				rig: {
					...machine(rig),
					work: rig.connected ? rigWork.toWork(rig.mpos) : null,
					// Where the camera really is (plans are in this frame).
					calibrated: rig.connected ? rigWork.toCalibrated(rig.mpos) : null,
					distortion: {
						enabled: project.addsub.rigDistortion.enabled,
						points: Object.keys(project.addsub.rigDistortion.samples),
						corrected: rigWork.corrected,
						correctionHere: rigWork.correctionNow,
					},
				},
				mill: machine(mill),
				sequence: {
					running: sequence.running,
					message: sequence.message,
					cutting: sequence.cutting,
					cutProgress: sequence.cutProgress,
					progress: sequence.progress,
				},
				captureShot: project.captureShot,
				shootAlerts: shootAlerts.alerts,
			}
		},
	})
}
