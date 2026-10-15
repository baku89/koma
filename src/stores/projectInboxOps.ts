/**
 * The project's own inbox ops (stores/inbox.ts): layers and shots.
 *
 *   {"op": "deleteLayer", "layer": "<id>"}
 *       Same as the Layers dialog's trash can: the slot is only marked, its
 *       shots and files stay, Restore brings it back.
 *   {"op": "deleteShots", "layer": "<id>", "from": 28, "to": 79}
 *       Takes the layer's shots in from…to (inclusive; `to` omitted = to the
 *       end) off the timeline. They go to the trash like any deleted shot;
 *       the frames themselves stay (nothing ripples shut).
 *   {"op": "moveShots", "layer": "<id>", "to": "<id>", "from": 0, "until": 84}
 *       Moves the layer's shots to the same frames of another layer (`from` /
 *       `until` optional, inclusive). Conflict: a target cell has a shot.
 *       The files are renamed by the next save.
 *   {"op": "setCapture", "layer": "<id>", "frame": 85}
 *       Moves the capture slot.
 *
 * `layer` is the layer id (project.layers[i].id). These change `komas`, so
 * the undo history is dropped once they are applied (an undo would bring
 * back the shots but not whatever else the patch changed).
 */

import {cloneDeep} from 'lodash-es'
import {nextTick, toRaw} from 'vue'

import {InboxConflict, type InboxOp, registerInboxOp} from './inbox'
import {useProjectStore} from './project'

export function setupProjectInbox() {
	const project = useProjectStore()

	function layerIndex(id: unknown, key = 'layer'): number {
		const index = project.layers.findIndex(l => l.id === id)
		if (index < 0) {
			throw new Error(
				`"${key}": no layer with id "${String(id)}" (have: ${project.layers.map(l => l.id).join(', ')})`
			)
		}
		return index
	}

	function frameOf(op: InboxOp, key: string, fallback: number): number {
		const value = op[key]
		if (value === undefined) return fallback
		if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
			throw new Error(`"${key}" must be a non-negative integer, got ${JSON.stringify(value)}`)
		}
		return value
	}

	/** Frames of a layer that hold a shot, within first…last. */
	function shotFrames(layer: number, first: number, last: number): number[] {
		const frames: number[] = []
		project.komas.forEach((koma, frame) => {
			if (frame >= first && frame <= last && koma?.shots?.[layer]) frames.push(frame)
		})
		return frames
	}

	function dropHistory() {
		nextTick(() => project.history.clear())
	}

	registerInboxOp('deleteLayer', op => {
		const index = layerIndex(op.layer)
		if (index === 0) throw new Error('the film (the first layer) cannot be deleted')
		const was = !!project.layers[index].deleted
		return {
			apply: () => {
				project.deleteLayer(index)
				return {deleted: was}
			},
		}
	})

	registerInboxOp('deleteShots', op => {
		const layer = layerIndex(op.layer)
		const first = frameOf(op, 'from', 0)
		const last = frameOf(op, 'to', Infinity)
		const frames = shotFrames(layer, first, last)
		return {
			apply: () => {
				for (const frame of frames) project.komas[frame].shots[layer] = null
				dropHistory()
				return {frames}
			},
		}
	})

	registerInboxOp('moveShots', (op, ctx) => {
		const source = layerIndex(op.layer)
		const target = layerIndex(op.to, 'to')
		if (source === target) throw new Error('"layer" and "to" are the same layer')
		if (project.layers[target].deleted) throw new Error('"to" is a deleted layer')
		const frames = shotFrames(source, frameOf(op, 'from', 0), frameOf(op, 'until', Infinity))
		const taken = frames.filter(frame => project.komas[frame].shots[target])
		if (taken.length > 0 && !ctx.overwrite) {
			throw new InboxConflict(
				`the target layer already has shots at frame ${taken.slice(0, 10).join(', ')}${taken.length > 10 ? ', …' : ''}`
			)
		}
		return {
			apply: () => {
				for (const frame of frames) {
					const shots = project.komas[frame].shots
					const shot = cloneDeep(toRaw(shots[source]))!
					shots[source] = null
					project.setShot(frame, target, shot)
				}
				dropHistory()
				return {frames, replaced: taken}
			},
		}
	})

	registerInboxOp('setCapture', op => {
		const layer = layerIndex(op.layer)
		if (project.layers[layer].deleted) throw new Error('"layer" is a deleted layer')
		const frame = frameOf(op, 'frame', -1)
		if (frame < 0) throw new Error('"frame" is required')
		return {
			apply: () => {
				const before = {
					layer: project.layers[project.captureShot.layer]?.id,
					frame: project.captureShot.frame,
				}
				project.captureShot = {frame, layer}
				dropHistory()
				return before
			},
		}
	})
}
