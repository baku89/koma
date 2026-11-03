/**
 * A layer's affine transform in a layer preset: scaled and rotated about the
 * centre of the frame, then shifted. Units are resolution-free so the same
 * numbers serve the Preview (CSS), the cast / playback canvases and the MP4
 * export: `scale` is a factor (1 = as is), `x` / `y` are percent of the frame
 * width / height, `rotate` is degrees clockwise.
 */
export interface LayerTransform {
	scale: number
	x: number
	y: number
	rotate: number
}

export const IDENTITY_TRANSFORM: Readonly<LayerTransform> = {scale: 1, x: 0, y: 0, rotate: 0}

export function layerTransformOf(t: Partial<LayerTransform> | null | undefined): LayerTransform {
	return {...IDENTITY_TRANSFORM, ...t}
}

export function isIdentityTransform(t: Partial<LayerTransform> | null | undefined): boolean {
	const {scale, x, y, rotate} = layerTransformOf(t)
	return scale === 1 && x === 0 && y === 0 && rotate === 0
}

/** CSS for an element the size of the frame (transform-origin at its centre). */
export function layerTransformCss(t: Partial<LayerTransform> | null | undefined): string | undefined {
	if (isIdentityTransform(t)) return undefined
	const {scale, x, y, rotate} = layerTransformOf(t)
	return `translate(${x}%, ${y}%) rotate(${rotate}deg) scale(${scale})`
}

/**
 * The same transform on a 2D context whose frame is `w` × `h` (multiplied
 * onto the current one; save / restore around it).
 */
export function applyLayerTransform(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	t: Partial<LayerTransform> | null | undefined,
	w: number,
	h: number
) {
	if (isIdentityTransform(t)) return
	const {scale, x, y, rotate} = layerTransformOf(t)
	ctx.translate(w / 2 + (x / 100) * w, h / 2 + (y / 100) * h)
	ctx.rotate((rotate * Math.PI) / 180)
	ctx.scale(scale, scale)
	ctx.translate(-w / 2, -h / 2)
}
