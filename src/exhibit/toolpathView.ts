/**
 * Annotated toolpath drawing for the exhibition's G-CODE pane, after the
 * catalogue plate: hairline path, and each G-code line's text at the end of
 * the move it produced. A slowly turning perspective view, drawn on a 2D
 * canvas (no WebGL needed for a few thousand segments).
 */

import {type Toolpath} from '@/utils/fluidnc'

export interface ToolpathScene {
	toolpath: Toolpath
	lines: string[]
}

/** One label every this many G-code lines (plus the header): enough to read
 *  the language of the file without burying the path in text. */
const LABEL_EVERY = 200

function cutBounds(tp: Toolpath) {
	let min: [number, number, number] | null = null
	let max: [number, number, number] | null = null
	for (const seg of tp.segments) {
		if (seg.rapid) continue
		for (const p of [seg.from, seg.to]) {
			if (!min || !max) {
				min = [...p]
				max = [...p]
				continue
			}
			for (let i = 0; i < 3; i++) {
				if (p[i] < min[i]) min[i] = p[i]
				if (p[i] > max[i]) max[i] = p[i]
			}
		}
	}
	return min && max ? {min, max} : null
}

export function drawToolpath(
	canvas: HTMLCanvasElement,
	scene: ToolpathScene,
	timeSec: number,
	opts: {font: string; color: string; dim: string; accent?: string; sentLines?: number} = {
		font: 'monospace',
		color: '#fff',
		dim: '#666',
	}
) {
	const ctx = canvas.getContext('2d')
	if (!ctx) return
	const dpr = window.devicePixelRatio || 1
	const w = canvas.clientWidth
	const h = canvas.clientHeight
	if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
		canvas.width = Math.round(w * dpr)
		canvas.height = Math.round(h * dpr)
	}
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
	ctx.clearRect(0, 0, w, h)

	const {toolpath, lines} = scene
	if (toolpath.segments.length === 0) return
	// Frame on the cut itself; rapids to the parking spot would squash it.
	const b = cutBounds(toolpath) ?? toolpath.bounds
	if (!b) return

	// Fit: centre of the bounds, radius from its diagonal.
	const cx = (b.min[0] + b.max[0]) / 2
	const cy = (b.min[1] + b.max[1]) / 2
	const cz = (b.min[2] + b.max[2]) / 2
	const radius = Math.max(
		1,
		Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2
	)

	// Camera orbiting slowly around the vertical (mill Z) axis, looking down at
	// ~35°. Mill coordinates: X right, Y away, Z up.
	const yaw = timeSec * 0.12
	const pitch = 0.6
	const dist = radius * 2.6
	const camX = cx + dist * Math.cos(pitch) * Math.sin(yaw)
	const camY = cy - dist * Math.cos(pitch) * Math.cos(yaw)
	const camZ = cz + dist * Math.sin(pitch)
	// Basis: forward f, right r, up u (camera space).
	const fx = cx - camX
	const fy = cy - camY
	const fz = cz - camZ
	const fl = Math.hypot(fx, fy, fz)
	const f = [fx / fl, fy / fl, fz / fl]
	// right = f × worldUp(0,0,1)
	let rx = f[1] * 1 - f[2] * 0
	let ry = f[2] * 0 - f[0] * 1
	let rz = f[0] * 0 - f[1] * 0
	const rl = Math.hypot(rx, ry, rz) || 1
	rx /= rl
	ry /= rl
	rz /= rl
	// up = r × f
	const ux = ry * f[2] - rz * f[1]
	const uy = rz * f[0] - rx * f[2]
	const uz = rx * f[1] - ry * f[0]
	const focal = Math.min(w, h) * 1.15

	const project = (p: [number, number, number]): [number, number, number] => {
		const dx = p[0] - camX
		const dy = p[1] - camY
		const dz = p[2] - camZ
		const zc = dx * f[0] + dy * f[1] + dz * f[2]
		const xc = dx * rx + dy * ry + dz * rz
		const yc = dx * ux + dy * uy + dz * uz
		const s = focal / Math.max(1e-3, zc)
		return [w / 2 + xc * s, h / 2 - yc * s, zc]
	}

	ctx.lineWidth = 0.6
	ctx.lineJoin = 'round'
	const sent = opts.sentLines ?? -1

	// Path
	for (const pass of ['rapid', 'cut', 'done'] as const) {
		ctx.beginPath()
		for (const seg of toolpath.segments) {
			const isDone = seg.line < sent
			const kind = isDone ? 'done' : seg.rapid ? 'rapid' : 'cut'
			if (kind !== pass) continue
			const a = project(seg.from)
			const c = project(seg.to)
			ctx.moveTo(a[0], a[1])
			ctx.lineTo(c[0], c[1])
		}
		ctx.strokeStyle = pass === 'done' ? (opts.accent ?? opts.color) : pass === 'rapid' ? opts.dim : opts.color
		// Hairlines at partial alpha: dense raster passes read as tone, not as a
		// solid fill.
		ctx.globalAlpha = pass === 'rapid' ? 0.25 : pass === 'done' ? 0.9 : 0.45
		ctx.stroke()
	}
	ctx.globalAlpha = 1

	// Labels: the text of every LABEL_EVERY-th source line, at the end of the
	// move it produced.
	const endOf = new Map<number, {to: [number, number, number]; rapid: boolean}>()
	for (const seg of toolpath.segments) endOf.set(seg.line, {to: seg.to, rapid: seg.rapid})
	ctx.font = `9px ${opts.font}`
	ctx.textBaseline = 'middle'
	ctx.globalAlpha = 0.85
	for (const [line, e] of endOf) {
		if (line % LABEL_EVERY !== 0) continue
		const p = project(e.to)
		if (p[2] <= 0) continue
		ctx.fillStyle = line < sent ? (opts.accent ?? opts.color) : e.rapid ? opts.dim : opts.color
		ctx.fillText(lines[line] ?? '', p[0] + 4, p[1])
	}
	ctx.globalAlpha = 1

	// Header lines (before the first move) stacked at the start point.
	const firstLine = toolpath.segments[0].line
	const start = project(toolpath.segments[0].from)
	ctx.fillStyle = opts.dim
	for (let i = 0; i < firstLine && i < 12; i++) {
		ctx.fillText(lines[i] ?? '', start[0] + 4, start[1] - 11 * (firstLine - i))
	}
}
