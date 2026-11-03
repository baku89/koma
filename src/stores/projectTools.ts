/**
 * The read side of koma's tools (stores/tools.ts): what the open project
 * looks like, for Claude Code and scripts before they change it. The write
 * side is the inbox ops (stores/inbox.ts, projectInboxOps.ts).
 */
import {getAssetFilename} from '@/utils/assets'
import {nativeDirPath} from '@/utils/nativePath'

import {inboxOpNames} from './inbox'
import {useProjectStore} from './project'
import {registerTool} from './tools'
import {useViewportStore} from './viewport'

const MAX_SHOTS = 500

export function setupProjectTools() {
	const project = useProjectStore()
	const viewport = useViewportStore()

	function layerAt(index: number) {
		const l = project.layers[index]
		return l ? {index, id: l.id, name: l.name} : null
	}

	function layerIndex(id: unknown): number {
		const index = project.layers.findIndex(l => l.id === id)
		if (index < 0) {
			throw new Error(`no layer with id "${String(id)}" (have: ${project.layers.map(l => l.id).join(', ')})`)
		}
		return index
	}

	registerTool({
		name: 'get_project',
		description:
			'The open project: name, folder, fps, frame count, layers (with their ids, which every other tool takes), the capture slot, the selection (current frame / layer / Shift-selected range), the preview range, and the ops `apply_patch` accepts.',
		inputSchema: {type: 'object', properties: {}, additionalProperties: false},
		execute: () => {
			const root = project.directoryHandle
			const layers = project.layers.map((l, i) => {
				let shots = 0
				let last = -1
				project.komas.forEach((k, frame) => {
					if (k?.shots?.[i]) {
						shots += 1
						last = frame
					}
				})
				return {index: i, id: l.id, name: l.name, dir: l.dir, deleted: !!l.deleted, shots, lastShotFrame: last < 0 ? null : last}
			})
			return {
				name: project.name,
				folder: nativeDirPath(root) ?? root?.name ?? null,
				hasFolder: !!root,
				fps: project.fps,
				frames: project.allKomas.length,
				previewRange: [...project.previewRange],
				captureShot: {frame: project.captureShot.frame, layer: layerAt(project.captureShot.layer)},
				selection: {
					frame: viewport.currentFrame,
					layer: layerAt(viewport.currentLayer),
					range: viewport.selectedRange ? [...viewport.selectedRange] : null,
				},
				activeLayerPreset: project.layerPresets.find(p => p.id === project.activeLayerPreset)?.name ?? null,
				layers,
				dirty: project.dirty,
				saving: project.isSaving,
				ops: inboxOpNames(),
			}
		},
	})

	registerTool({
		name: 'get_shots',
		description:
			'The shots of a layer in from…to (inclusive; at most 500): frame, capture time, file names (jpg / lv / raw), camera configs and whatever the shot recorded (rig axes, cut, LED record). Frames without a shot are left out.',
		inputSchema: {
			type: 'object',
			properties: {
				layer: {type: 'string', description: 'Layer id (see get_project).'},
				from: {type: 'integer', minimum: 0, description: 'First frame (default 0).'},
				to: {type: 'integer', minimum: 0, description: 'Last frame, inclusive (default: the end).'},
			},
			required: ['layer'],
			additionalProperties: false,
		},
		execute: args => {
			const layer = layerIndex(args.layer)
			const first = Number.isInteger(args.from) ? args.from : 0
			const last = Number.isInteger(args.to) ? args.to : Infinity
			const shots: Record<string, unknown>[] = []
			let truncated = false
			for (let frame = first; frame < project.komas.length && frame <= last; frame++) {
				const shot = project.komas[frame]?.shots?.[layer]
				if (!shot) continue
				if (shots.length >= MAX_SHOTS) {
					truncated = true
					break
				}
				const {lv, jpg, raw, ...rest} = shot
				shots.push({
					frame,
					...rest,
					captureDate: shot.captureDate ? new Date(shot.captureDate).toISOString() : undefined,
					jpg: getAssetFilename(jpg) ?? null,
					lv: getAssetFilename(lv) ?? null,
					raw: raw ? (getAssetFilename(raw) ?? null) : undefined,
				})
			}
			return {layer: layerAt(layer), count: shots.length, truncated, shots}
		},
	})
}
