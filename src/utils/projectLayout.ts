/**
 * Where a project keeps its images on disk (ADDSUB.md §14.2).
 *
 * Layout 3 (new projects): one folder per layer, named after the layer,
 * holding that layer's frames as `<project>_<layer>_<frame>` — a file names
 * its project and layer itself, so it still means something in a Dropbox
 * event list, a Finder search or a _trash folder —
 *
 *   <project>/Main/film_Main_0001.jpg      hi-res capture
 *   <project>/Main/film_Main_0001.lv.jpg   preview (live-view size)
 *   <project>/Main/film_Main_0001.dng      raw, when the camera gives one
 *   <project>/Main/gcode/0041_x.nc         G-code attached to a frame (addsub)
 *   <project>/_trash/Main/<id>__film_Main_0001.jpg   displaced shots (assets.ts)
 *
 * Layout 2 (2026-10-16 only): the same folders, files named by number alone
 * (`Main/0001.jpg`). Kept readable; the migration below renames to layout 3.
 *
 * The folder name is `Layer.dir`: made from the layer's name when the layer
 * is created, and renamed with it when the name is confirmed (not on every
 * keystroke — on a folder project that is a copy of every file). Nothing is
 * read back from a file's name: project.json holds every path.
 *
 * Layout 1 (projects from before): everything flat in the project folder as
 * `<project name>_layer=<slot>_<frame>.jpg`. Such a project keeps that layout
 * until it is migrated (koma's "Move Images into Layer Folders" command, or
 * scripts/migrate-layer-folders.mjs, which renames without copying). The
 * same two take layout 2 to 3.
 *
 * Pure functions, shared by the project store and (in spirit — it can't import
 * TypeScript) the Node scripts; keep `layerDirName` in step with theirs.
 */

export type AssetLayout = 1 | 2 | 3

/** Layouts 2 and 3 keep each layer's images in a folder of its own. */
export function hasLayerFolders(layout: AssetLayout | undefined): boolean {
	return layout === 2 || layout === 3
}

export type FrameAssetType = 'lv' | 'jpg' | 'raw'

/** Folder names koma itself uses at the project root; a layer can't take them. */
export const RESERVED_PROJECT_DIRS = ['_inbox', '_trash', 'gcode', 'led-wall', 'previz']

/**
 * A folder name for a layer called `name`, not clashing (case-insensitively —
 * macOS and Windows file systems don't tell "Main" from "main") with `taken`
 * nor with koma's own folders. Unsafe characters become `_`, leading dots and
 * underscores go (hidden files / koma's prefix), trailing dots and spaces too
 * (Windows); a clash gets " 2", " 3", ….
 */
export function layerDirName(name: string, taken: Iterable<string> = []): string {
	let base = safeFileName(name)
	if (!base) base = 'Layer'
	const used = new Set<string>()
	for (const t of taken) used.add(t.toLowerCase())
	for (const r of RESERVED_PROJECT_DIRS) used.add(r.toLowerCase())
	if (!used.has(base.toLowerCase())) return base
	for (let n = 2; ; n++) {
		const candidate = `${base} ${n}`
		if (!used.has(candidate.toLowerCase())) return candidate
	}
}

/**
 * `name` as something a file system accepts, or '' if nothing is left. Every
 * kind of space (the ideographic U+3000 included) becomes one plain space,
 * unsafe characters `_`, leading dots / underscores and trailing dots go.
 */
export function safeFileName(name: string): string {
	return (
		name
			.replace(/\p{White_Space}+/gu, ' ')
			.trim()
			// eslint-disable-next-line no-control-regex
			.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
			.replace(/^[._ ]+/, '')
			.replace(/[. ]+$/, '')
			.slice(0, 80)
			.trim()
	)
}

/** Case-insensitive folder name equality (what the file system will say). */
export function sameDirName(a: string | undefined, b: string | undefined): boolean {
	return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase()
}

const padFrame = (frame: number) => frame.toString().padStart(4, '0')
const extOf = (type: FrameAssetType) => (type === 'raw' ? 'dng' : 'jpg')
// Live-view as a `.lv` sub-extension so files sort by frame: 0001.jpg,
// 0001.lv.jpg, 0002.jpg.
const subOf = (type: FrameAssetType) => (type === 'lv' ? '.lv' : '')

/** Layout 2: `<dir>/0001.jpg`. */
export function layerAssetPath(dir: string, frame: number, type: FrameAssetType): string {
	return `${dir}/${padFrame(frame)}${subOf(type)}.${extOf(type)}`
}

/**
 * Layout 3: what every image of a layer starts with — `<project>_<layer dir>`,
 * so a file says where it belongs even outside its folder. The project name
 * goes through the same cleaning as a folder name.
 */
export function assetFileStem(projectName: string, dir: string): string {
	return `${safeFileName(projectName) || 'project'}_${dir}`
}

/** Layout 3: `<dir>/<project>_<dir>_0001.jpg`. */
export function namedAssetPath(
	projectName: string,
	dir: string,
	frame: number,
	type: FrameAssetType
): string {
	return `${dir}/${assetFileStem(projectName, dir)}_${padFrame(frame)}${subOf(type)}.${extOf(type)}`
}

/** Layout 1: `<project name>_layer=<slot>_0001.jpg`, flat in the project folder. */
export function legacyFrameAssetFilename(
	name: string,
	layer: number,
	frame: number,
	type: FrameAssetType
): string {
	return `${name}_layer=${layer}_${padFrame(frame)}${subOf(type)}.${extOf(type)}`
}

export interface LayoutProject {
	name: string
	assetLayout?: AssetLayout
	layers: readonly {dir?: string}[]
}

/**
 * The path (relative to the project folder) a frame's image should be at.
 * Layout 2 needs the layer's `dir`; a layer without one (shouldn't happen
 * after normalizeLayers) falls back to the flat name so nothing is lost.
 */
export function frameAssetPath(
	p: LayoutProject,
	layer: number,
	frame: number,
	type: FrameAssetType
): string {
	const dir = hasLayerFolders(p.assetLayout) ? p.layers[layer]?.dir : undefined
	if (!dir) return legacyFrameAssetFilename(p.name, layer, frame, type)
	return p.assetLayout === 3
		? namedAssetPath(p.name, dir, frame, type)
		: layerAssetPath(dir, frame, type)
}

/** Layout 2: where a layer's attached G-code goes (`<dir>/gcode/`). */
export function layerGcodeDir(dir: string): string {
	return `${dir}/gcode`
}
