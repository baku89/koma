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
 *       `rig` is in the rig's work coordinates. Conflict: the frame already
 *       has a plan of its own. Two more fields, for Houdini (koma_bridge.py
 *       "Send Plans"):
 *         "camera": {"position": [x, y, z], "rotation": [x, y, z, w] |
 *                    "angles": {tilt, pan, roll}, "frame": "world"|"rig",
 *                    "unit": "m"|"mm"}   — a camera pose like `rig:pose`;
 *                    stored as the plan's camera (world mm) and, unless
 *                    "solveRig": false, solved to rig axes too (work coords,
 *                    checked against the limits).
 *         "led": {"rgb": "<base64, 3 bytes per pixel, all lines>"} — the
 *                    wall for the frame; written to led-wall/<hash>.ledwall
 *                    (as shots record it) and referenced by the plan. Or
 *                    {"file": "led-wall/….ledwall"} for a record that exists.
 *   {"op": "clearPlan", "layer": "main", "frame": 41}
 *   {"op": "moveLayerData", "layer": "main", "to": "<id>"}
 *       Moves every plan and cut record of a layer to the same frames of
 *       another layer (the G-code files stay where they are). Conflict: the
 *       target layer has a plan or cut at one of those frames.
 *
 * `layer` is the layer id (project.layers[i].id), `frame` the timeline frame.
 */

import {cloneDeep} from 'lodash-es'

import {InboxConflict, type InboxOp, registerInboxOp} from '@/stores/inbox'
import {useProjectStore} from '@/stores/project'
import {AXES, type Axis, prepareGCode} from '@/utils/fluidnc'
import {parseToolpathCached} from '@/utils/fluidnc/toolpathParser'

import {cutFor, isGcodeFilename, readProjectText, setCut} from './cuts'
import {cameraPoseToRigAxes} from './kinematics'
import {encodeWall, wallRecordPath} from './led/wallRecord'
import {type FramePlan, planFor, type PlanLed, setPlan} from './plan'
import {parseCameraPoseMessage} from './poseMessage'
import type {FrameCut} from './projectData'
import {useLedStore} from './stores/led'
import {useRigWorkStore} from './stores/rigWork'
import {useSequenceStore} from './stores/sequence'

export function setupAddsubInbox() {
	const project = useProjectStore()
	const rigWork = useRigWorkStore()
	const sequence = useSequenceStore()
	const led = useLedStore()

	/** Every axis of `rig` within the travel limits (work coordinates). */
	function checkRigAxes(rig: Record<string, unknown>) {
		const limits = project.addsub.rigLimits as Record<string, [number, number] | undefined>
		for (const [axis, value] of Object.entries(rig)) {
			if (!(AXES as readonly string[]).includes(axis)) {
				throw new Error(`plan.rig: unknown axis "${axis}"`)
			}
			if (typeof value !== 'number' || !Number.isFinite(value)) {
				throw new Error(`plan.rig.${axis} must be a number`)
			}
			// The plan is in work coordinates, the travel limits are machine.
			const range = limits[axis]?.map(m => rigWork.axisToWork(axis as Axis, m))
			if (range && (value < range[0] || value > range[1])) {
				throw new Error(`plan.rig.${axis} = ${value} is outside [${range[0]}, ${range[1]}]`)
			}
		}
	}

	function decodeBase64(s: string): Uint8Array {
		const bin = atob(s)
		const out = new Uint8Array(bin.length)
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
		return out
	}

	/**
	 * The plan's wall: a record written now from the pixels sent (content-
	 * addressed, so writing it before the patch is accepted changes nothing
	 * the project refers to), or a record already in the folder.
	 */
	async function planLed(input: any): Promise<PlanLed> {
		if (typeof input?.file === 'string') {
			try {
				await readProjectText(project.directoryHandle!, input.file)
			} catch {
				throw new Error(`plan.led.file not found in the project: ${input.file}`)
			}
			return {file: input.file, layoutVersion: led.layout.version}
		}
		let rgb: Uint8Array
		if (typeof input?.rgb === 'string') {
			try {
				rgb = decodeBase64(input.rgb)
			} catch {
				throw new Error('plan.led.rgb is not base64')
			}
		} else if (Array.isArray(input?.rgb)) {
			rgb = Uint8Array.from(input.rgb, (n: unknown) => Math.max(0, Math.min(255, Number(n) | 0)))
		} else throw new Error('plan.led needs rgb (base64 or bytes) or file')
		const counts = led.layout.lineCounts
		const total = counts.reduce((s, n) => s + n, 0) * 3
		if (rgb.length !== total) {
			throw new Error(`plan.led.rgb has ${rgb.length / 3} pixels, the wall has ${total / 3}`)
		}
		const lines: Uint8Array[] = []
		let offset = 0
		for (const n of counts) {
			lines.push(rgb.subarray(offset, offset + n * 3))
			offset += n * 3
		}
		const encoded = encodeWall(lines)
		const file = await wallRecordPath(encoded)
		await project.writeProjectFile(file, new Blob([encoded as BlobPart]))
		return {file, layoutVersion: led.layout.version}
	}

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

	registerInboxOp('setPlan', async (op, ctx) => {
		const {layer, frame} = cell(op)
		const input = op.plan as Record<string, any> | undefined
		if (!input || typeof input !== 'object' || Array.isArray(input)) {
			throw new Error('"plan" must be an object')
		}
		if (!input.rig && !input.camera && !input.cameraConfigs && !input.led) {
			throw new Error('"plan" needs rig, camera, cameraConfigs or led')
		}
		const plan: FramePlan = {}
		if (input.camera) {
			// A pose message (position + rotation / angles, any frame, any
			// unit) → the plan's world pose; a plain stored pose passes through.
			const c = input.camera
			const stored = Array.isArray(c.position) && Array.isArray(c.rotation) && !c.frame && !c.unit
			try {
				plan.camera = stored
					? {position: [...c.position] as any, rotation: [...c.rotation] as any}
					: parseCameraPoseMessage(c, project.addsub.calibration)
			} catch (e) {
				throw new Error(`plan.camera: ${e instanceof Error ? e.message : String(e)}`)
			}
			if (input.rig === undefined && input.solveRig !== false) {
				const machine = cameraPoseToRigAxes(plan.camera, project.addsub.calibration)
				plan.rig = rigWork.toWork(machine)
			}
		}
		if (input.rig) {
			if (typeof input.rig !== 'object' || Array.isArray(input.rig)) throw new Error('plan.rig must be an object')
			plan.rig = {...input.rig}
		}
		if (plan.rig) checkRigAxes(plan.rig as Record<string, unknown>)
		if (input.cameraConfigs) {
			if (typeof input.cameraConfigs !== 'object') throw new Error('plan.cameraConfigs must be an object')
			plan.cameraConfigs = {...input.cameraConfigs}
		}
		if (input.led) plan.led = await planLed(input.led)
		if (typeof input.note === 'string') plan.note = input.note
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

	registerInboxOp('moveLayerData', (op, ctx) => {
		const ids = [op.layer, op.to].map((id, i) => {
			const layer = project.layers.find(l => l.id === id)
			if (!layer) throw new Error(`"${i ? 'to' : 'layer'}": no layer with id "${String(id)}"`)
			return layer.id
		})
		const [from, to] = ids
		if (from === to) throw new Error('"layer" and "to" are the same layer')
		if (sequence.cutting) throw new Error('a cut is running right now')
		const tables = [project.addsub.plan, project.addsub.cuts] as Record<
			string,
			Record<number, unknown>
		>[]
		const taken = tables.flatMap(table =>
			Object.keys(table[from] ?? {}).filter(frame => table[to]?.[Number(frame)] !== undefined)
		)
		if (taken.length > 0 && !ctx.overwrite) {
			throw new InboxConflict(
				`the target layer already has a plan or cut at frame ${[...new Set(taken)].slice(0, 10).join(', ')}`
			)
		}
		return {
			apply: () => {
				const moved = tables.map(table => {
					const source = table[from]
					if (!source) return 0
					table[to] = {...table[to], ...source}
					delete table[from]
					return Object.keys(source).length
				})
				return {plans: moved[0], cuts: moved[1]}
			},
		}
	})
}
