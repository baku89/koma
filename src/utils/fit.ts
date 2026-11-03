/**
 * `object-fit: contain` for canvas drawing: the rectangle a `sw` × `sh` picture
 * takes when scaled to fit inside `w` × `h`, centred.
 */
export function fitContain(
	sw: number,
	sh: number,
	w: number,
	h: number
): {x: number; y: number; width: number; height: number} {
	const s = Math.min(w / sw, h / sh)
	const width = sw * s
	const height = sh * s
	return {x: (w - width) / 2, y: (h - height) / 2, width, height}
}
