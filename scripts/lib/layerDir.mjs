/**
 * Folder name for a layer — a port of src/utils/projectLayout.ts
 * `layerDirName` for the Node scripts (they can't import TypeScript). Keep
 * the two in step.
 */
export const RESERVED_PROJECT_DIRS = ['_inbox', '_trash', 'gcode', 'led-wall', 'previz']

export function layerDirName(name, taken = []) {
	let base = name
		.replace(/\p{White_Space}+/gu, ' ')
		.trim()
		// eslint-disable-next-line no-control-regex
		.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
		.replace(/^[._ ]+/, '')
		.replace(/[. ]+$/, '')
		.slice(0, 80)
		.trim()
	if (!base) base = 'Layer'
	const used = new Set([...taken, ...RESERVED_PROJECT_DIRS].map(s => s.toLowerCase()))
	if (!used.has(base.toLowerCase())) return base
	for (let n = 2; ; n++) {
		const c = `${base} ${n}`
		if (!used.has(c.toLowerCase())) return c
	}
}
