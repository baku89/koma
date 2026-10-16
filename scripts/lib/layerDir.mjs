/**
 * Folder name for a layer — a port of src/utils/projectLayout.ts
 * `layerDirName` for the Node scripts (they can't import TypeScript). Keep
 * the two in step.
 */
export const RESERVED_PROJECT_DIRS = ['_inbox', '_trash', 'gcode', 'led-wall', 'previz']

export function safeFileName(name) {
	return name
		.replace(/\p{White_Space}+/gu, ' ')
		.trim()
		// eslint-disable-next-line no-control-regex
		.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
		.replace(/^[._ ]+/, '')
		.replace(/[. ]+$/, '')
		.slice(0, 80)
		.trim()
}

export function layerDirName(name, taken = []) {
	let base = safeFileName(name)
	if (!base) base = 'Layer'
	const used = new Set([...taken, ...RESERVED_PROJECT_DIRS].map(s => s.toLowerCase()))
	if (!used.has(base.toLowerCase())) return base
	for (let n = 2; ; n++) {
		const c = `${base} ${n}`
		if (!used.has(c.toLowerCase())) return c
	}
}

/** Layout 3 image name: `<project>_<layer dir>_0001.jpg` / `.lv.jpg` / `.dng` (port of namedAssetPath's basename). */
export function assetFileName(projectName, dir, frame, type) {
	const stem = `${safeFileName(projectName) || 'project'}_${dir}`
	return `${stem}_${String(frame).padStart(4, '0')}${type === 'lv' ? '.lv' : ''}.${type === 'raw' ? 'dng' : 'jpg'}`
}
