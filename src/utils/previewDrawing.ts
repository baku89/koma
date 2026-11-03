import {vec2} from 'linearly'

/**
 * A pencil stroke drawn over the preview, in frame pixels. The points are kept
 * as an SVG path string rather than an array: the deep autosave / history
 * watchers walk the whole project on every change, and a string costs them
 * nothing however long the stroke is.
 */
export interface PreviewStroke {
	color: string
	d: string
}

const round = (v: number) => Math.round(v * 10) / 10

/** The path of a stroke starting at `p`. Drawn as a dot until it gets longer. */
export function startStrokePath([x, y]: vec2) {
	return `M${round(x)} ${round(y)}L${round(x)} ${round(y)}`
}

export function extendStrokePath(d: string, [x, y]: vec2) {
	return `${d}L${round(x)} ${round(y)}`
}

export function strokePathPoints(d: string): vec2[] {
	const values = d.match(/-?[\d.]+/g)?.map(Number) ?? []
	const points: vec2[] = []
	for (let i = 0; i + 1 < values.length; i += 2) {
		points.push([values[i], values[i + 1]])
	}
	return points
}

function distanceToSegment(p: vec2, a: vec2, b: vec2) {
	const abX = b[0] - a[0]
	const abY = b[1] - a[1]
	const lengthSq = abX * abX + abY * abY
	const t =
		lengthSq === 0
			? 0
			: Math.max(
					0,
					Math.min(1, ((p[0] - a[0]) * abX + (p[1] - a[1]) * abY) / lengthSq)
				)
	return Math.hypot(p[0] - a[0] - t * abX, p[1] - a[1] - t * abY)
}

function segmentsCross(a: vec2, b: vec2, c: vec2, d: vec2) {
	const side = (p: vec2, q: vec2, r: vec2) =>
		(q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
	return (
		side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0
	)
}

/** Whether the eraser's move from `a` to `b` touches the polyline. */
export function eraserHitsStroke(
	points: vec2[],
	a: vec2,
	b: vec2,
	tolerance: number
) {
	for (let i = 0; i + 1 < points.length; i++) {
		const p = points[i]
		const q = points[i + 1]
		if (
			segmentsCross(a, b, p, q) ||
			distanceToSegment(a, p, q) <= tolerance ||
			distanceToSegment(b, p, q) <= tolerance ||
			distanceToSegment(p, a, b) <= tolerance ||
			distanceToSegment(q, a, b) <= tolerance
		) {
			return true
		}
	}
	return false
}
