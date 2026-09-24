/**
 * Turn G-code into a toolpath: a list of straight segments (arcs are
 * flattened) with the index of the source line that produced each, so a
 * viewer can draw it and highlight how far a streamed job has got.
 *
 * Understands what CAM output uses: G0/G1/G2/G3 (modal), G17/18/19 planes,
 * G90/G91, G20/G21, X/Y/Z/I/J/K/R words, F. Everything else is ignored.
 * Coordinates are left in the work coordinate system of the file.
 */

export interface ToolpathSegment {
	/** Start / end in file units (mm after G20 conversion). */
	from: [number, number, number]
	to: [number, number, number]
	rapid: boolean
	/** Index into the `lines` array given to {@link parseToolpath}. */
	line: number
}

export interface Toolpath {
	segments: ToolpathSegment[]
	/** Bounding box of every point, or null when empty. */
	bounds: {min: [number, number, number]; max: [number, number, number]} | null
	/** Total cutting (non-rapid) length. */
	cutLength: number
}

type Vec = [number, number, number]

const PLANES = {
	17: [0, 1, 2], // XY, normal Z
	18: [2, 0, 1], // ZX, normal Y
	19: [1, 2, 0], // YZ, normal X
} as const

export function parseToolpath(
	lines: readonly string[],
	opts: {start?: Vec; arcSegmentMm?: number} = {}
): Toolpath {
	const segments: ToolpathSegment[] = []
	let pos: Vec = opts.start ? [...opts.start] : [0, 0, 0]
	let motion: 0 | 1 | 2 | 3 = 0
	let absolute = true
	let unitScale = 1 // 25.4 after G20
	let plane: 17 | 18 | 19 = 17
	const arcStep = opts.arcSegmentMm ?? 0.5

	let min: Vec | null = null
	let max: Vec | null = null
	let cutLength = 0

	const grow = (p: Vec) => {
		if (!min || !max) {
			min = [...p]
			max = [...p]
			return
		}
		for (let i = 0; i < 3; i++) {
			if (p[i] < min[i]) min[i] = p[i]
			if (p[i] > max[i]) max[i] = p[i]
		}
	}

	let moved = false
	const push = (to: Vec, rapid: boolean, line: number) => {
		segments.push({from: [...pos], to: [...to], rapid, line})
		if (!rapid) cutLength += Math.hypot(to[0] - pos[0], to[1] - pos[1], to[2] - pos[2])
		// The synthetic start position isn't part of the path's extent.
		if (moved) grow(pos)
		grow(to)
		moved = true
		pos = to
	}

	lines.forEach((raw, lineIndex) => {
		const text = raw.replace(/\(.*?\)/g, '').replace(/;.*$/, '').trim().toUpperCase()
		if (!text) return
		const words: Record<string, number> = {}
		let hasMotionWord = false
		let machineCoords = false
		for (const m of text.matchAll(/([A-Z])\s*([-+]?\d*\.?\d+)/g)) {
			const letter = m[1]
			const value = Number(m[2])
			if (letter === 'G') {
				if (value === 0 || value === 1 || value === 2 || value === 3) {
					motion = value
					hasMotionWord = true
				} else if (value === 53) machineCoords = true
				else if (value === 90) absolute = true
				else if (value === 91) absolute = false
				else if (value === 20) unitScale = 25.4
				else if (value === 21) unitScale = 1
				else if (value === 17 || value === 18 || value === 19) plane = value
			} else {
				words[letter] = value
			}
		}
		void hasMotionWord

		// G53 moves are in machine coordinates (an unknown offset from the work
		// system): a one-line rapid to a safe spot. Not part of the cut; skip it
		// without disturbing the tracked position.
		if (machineCoords) return

		const hasAxis = 'X' in words || 'Y' in words || 'Z' in words
		if (!hasAxis && !('I' in words || 'J' in words || 'K' in words || 'R' in words)) return

		const target: Vec = [...pos]
		;(['X', 'Y', 'Z'] as const).forEach((axis, i) => {
			if (axis in words) {
				const v = words[axis] * unitScale
				target[i] = absolute ? v : pos[i] + v
			}
		})

		if (motion === 0 || motion === 1) {
			if (hasAxis) push(target, motion === 0, lineIndex)
			return
		}

		// Arc (G2 clockwise / G3 counter-clockwise) in the active plane.
		const [a, b, n] = PLANES[plane]
		const start2: [number, number] = [pos[a], pos[b]]
		const end2: [number, number] = [target[a], target[b]]
		let centre: [number, number]
		const ijk = [words.I, words.J, words.K].map(v => (v ?? 0) * unitScale)
		if ('R' in words) {
			const r = words.R * unitScale
			const dx = end2[0] - start2[0]
			const dy = end2[1] - start2[1]
			const d = Math.hypot(dx, dy)
			const h2 = r * r - (d * d) / 4
			const h = h2 > 0 ? Math.sqrt(h2) : 0
			const mid: [number, number] = [start2[0] + dx / 2, start2[1] + dy / 2]
			// Sign picks the shorter (r > 0) or longer (r < 0) arc.
			const s = (motion === 2 ? -1 : 1) * Math.sign(r || 1)
			centre = [mid[0] - (s * h * dy) / (d || 1), mid[1] + (s * h * dx) / (d || 1)]
		} else {
			centre = [start2[0] + ijk[a], start2[1] + ijk[b]]
		}
		const radius = Math.hypot(start2[0] - centre[0], start2[1] - centre[1])
		const a0 = Math.atan2(start2[1] - centre[1], start2[0] - centre[0])
		let a1 = Math.atan2(end2[1] - centre[1], end2[0] - centre[0])
		if (motion === 2) {
			if (a1 >= a0) a1 -= Math.PI * 2
		} else if (a1 <= a0) a1 += Math.PI * 2
		const full = Math.abs(a1 - a0) < 1e-9 && Math.hypot(end2[0] - start2[0], end2[1] - start2[1]) < 1e-9
		if (full) a1 = a0 + (motion === 2 ? -1 : 1) * Math.PI * 2
		const sweep = a1 - a0
		const steps = Math.max(1, Math.ceil((Math.abs(sweep) * radius) / arcStep))
		const nStart = pos[n]
		const nEnd = target[n]
		for (let i = 1; i <= steps; i++) {
			const t = i / steps
			const ang = a0 + sweep * t
			const p: Vec = [0, 0, 0]
			p[a] = centre[0] + radius * Math.cos(ang)
			p[b] = centre[1] + radius * Math.sin(ang)
			p[n] = nStart + (nEnd - nStart) * t
			if (i === steps) {
				p[a] = end2[0]
				p[b] = end2[1]
			}
			push(p, false, lineIndex)
		}
	})

	return {segments, bounds: min && max ? {min, max} : null, cutLength}
}
