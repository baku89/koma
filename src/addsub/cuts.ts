/**
 * Per-frame cuts (ADDSUB.md §2 step 1, §13): the G-code a frame has to run
 * on the mill before it is shot, and what happened when it ran.
 *
 * A frame's G-code comes from one of two places, in this order:
 *   1. a file the operator dropped on the timeline cell (copied into the
 *      project folder under `gcode/<layer id>/`), recorded here as a
 *      `FrameCut` with `source: 'file'`;
 *   2. the cut previz/frames.json plans for the frame (previz store).
 * Either way the *run* is recorded here, so "has this frame been cut?" is
 * one lookup — the shoot condition (shootConditions.ts) refuses the shutter
 * until it has, and the exhibition can show mill times.
 *
 * Pure helpers (no store), like plan.ts.
 */

import type {Project} from '@/stores/project'

import type {CutRun, CutTable, FrameCut} from './projectData'

export type {CutRun, CutTable, FrameCut}

/** Folder (relative to the project) dropped G-code files are copied into. */
export const CUTS_DIR = 'gcode'

export const GCODE_EXTENSIONS = ['.nc', '.gcode', '.ngc', '.tap', '.cnc', '.txt']

export function cutFor(project: Project, frame: number, layer: number): FrameCut | undefined {
	const id = project.layers[layer]?.id
	if (id === undefined) return undefined
	return project.addsub.cuts[id]?.[frame]
}

/** Replace (or with `null`, remove) the cut record of one frame of a layer. */
export function setCut(project: Project, frame: number, layer: number, cut: FrameCut | null) {
	const id = project.layers[layer]?.id
	if (id === undefined) return
	const table = project.addsub.cuts
	if (cut === null) {
		if (!table[id]) return
		delete table[id][frame]
		if (Object.keys(table[id]).length === 0) delete table[id]
		return
	}
	if (!table[id]) table[id] = {}
	table[id][frame] = cut
}

/** Whether the frame's G-code has run to the end (with its current file). */
export function isCutDone(cut: FrameCut | undefined | null): boolean {
	return !!cut?.run?.done
}

/** Where a dropped file goes: `gcode/<layer id>/<frame>_<name>`. */
export function cutFilePath(layerId: string, frame: number, name: string): string {
	const safe = name.replace(/[\\/:*?"<>|]/g, '_')
	return `${CUTS_DIR}/${layerId}/${String(frame).padStart(4, '0')}_${safe}`
}

export function isGcodeFilename(name: string): boolean {
	const lower = name.toLowerCase()
	return GCODE_EXTENSIONS.some(ext => lower.endsWith(ext))
}

/**
 * Ratio of measured to estimated cut time over the project's finished runs
 * (1 when nothing has been measured yet). The parser ignores acceleration,
 * so real cuts of many short moves take longer than it says; scaling by what
 * this mill actually did is a cheap, honest ETA.
 */
export function measuredTimeRatio(project: Project): number {
	let est = 0
	let real = 0
	for (const byFrame of Object.values(project.addsub.cuts)) {
		for (const cut of Object.values(byFrame)) {
			const r = cut.run
			if (!r?.done || !r.estimatedSec || r.estimatedSec < 1) continue
			est += r.estimatedSec
			real += r.durationMs / 1000
		}
	}
	if (est < 30) return 1
	return Math.min(5, Math.max(0.3, real / est))
}

/** Total mill time (ms) recorded on the project's runs, done or not. */
export function totalMillTime(project: Project): number {
	let ms = 0
	for (const byFrame of Object.values(project.addsub.cuts)) {
		for (const cut of Object.values(byFrame)) ms += cut.run?.durationMs ?? 0
	}
	return ms
}

/** Frames of a layer that have a cut record, ascending. */
export function cutFrames(project: Project, layer: number): number[] {
	const id = project.layers[layer]?.id
	if (id === undefined) return []
	return Object.keys(project.addsub.cuts[id] ?? {})
		.map(Number)
		.sort((a, b) => a - b)
}

/** "3:21" / "1:02:05" for a duration in ms. */
export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000))
	const h = Math.floor(s / 3600)
	const m = Math.floor((s % 3600) / 60)
	const sec = s % 60
	const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
	return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`
}

//------------------------------------------------------------------------------
// Reading a file by path under a directory handle (`/`-separated). Writing
// goes through the project store (it owns the folder and creates it for a
// fresh in-app project).

async function projectFile(root: FileSystemDirectoryHandle, rel: string): Promise<File> {
	const parts = rel.split('/').filter(Boolean)
	let dir = root
	for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p)
	return (await dir.getFileHandle(parts[parts.length - 1])).getFile()
}

export async function readProjectText(root: FileSystemDirectoryHandle, rel: string): Promise<string> {
	return (await projectFile(root, rel)).text()
}

export async function readProjectBytes(root: FileSystemDirectoryHandle, rel: string): Promise<Uint8Array> {
	return new Uint8Array(await (await projectFile(root, rel)).arrayBuffer())
}
