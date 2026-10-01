/**
 * Parses a G-code file off the main thread (the exhibition's G-CODE pane,
 * the cut preview in the 3D view) and returns it in the shape a WebGL view
 * uploads directly: one flat position buffer (already in three.js axes:
 * mill X → x, mill Z → y, mill Y → −z), per-segment rapid flags, source-line
 * numbers and estimated times, and the few labels. Screen A plays at frame
 * rate and every frame may have its own cut, so this runs often; the main
 * thread only ever touches typed arrays.
 */

import {prepareGCode} from './gcode'
import {parseToolpath} from './toolpath'

/** One label every this many G-code lines (plus the header). */
export const LABEL_EVERY = 200

export interface ToolpathLabel {
	/** Source line; negative for the header stack (−k = k lines before the first move). */
	line: number
	text: string
	position: [number, number, number]
	rapid: boolean
}

export interface CompactToolpath {
	/** 6 floats per segment: from xyz, to xyz (three.js axes). */
	positions: Float32Array
	/** 1 per segment. */
	rapid: Uint8Array
	/** Source line index per segment. */
	line: Uint32Array
	/** Estimated seconds from program start to the end of each segment. */
	time: Float32Array
	labels: ToolpathLabel[]
	/** Bounding box of the cutting moves (all moves when there are none). */
	centre: [number, number, number]
	radius: number
	lineCount: number
	cutLength: number
	/** Estimated run time (s), see parseToolpath. */
	seconds: number
}

export interface ParseRequest {
	id: number
	text: string
}

export interface ParseResponse {
	id: number
	result: CompactToolpath | null
}

export function compactToolpath(text: string): CompactToolpath | null {
	const lines = prepareGCode(text).map(l => l.line)
	const tp = parseToolpath(lines)
	const n = tp.segments.length
	if (n === 0) return null

	const positions = new Float32Array(n * 6)
	const rapid = new Uint8Array(n)
	const line = new Uint32Array(n)
	const time = new Float32Array(n)
	const endOf = new Map<number, {to: [number, number, number]; rapid: boolean}>()

	let minX = Infinity
	let minY = Infinity
	let minZ = Infinity
	let maxX = -Infinity
	let maxY = -Infinity
	let maxZ = -Infinity
	let cutSeen = false

	const grow = (x: number, y: number, z: number) => {
		if (x < minX) minX = x
		if (y < minY) minY = y
		if (z < minZ) minZ = z
		if (x > maxX) maxX = x
		if (y > maxY) maxY = y
		if (z > maxZ) maxZ = z
	}

	for (let pass = 0; pass < 2; pass++) {
		// Pass 0 measures the cutting moves; pass 1 (only when there were none)
		// measures everything.
		for (let i = 0; i < n; i++) {
			const seg = tp.segments[i]
			if (pass === 0) {
				positions[i * 6] = seg.from[0]
				positions[i * 6 + 1] = seg.from[2]
				positions[i * 6 + 2] = -seg.from[1]
				positions[i * 6 + 3] = seg.to[0]
				positions[i * 6 + 4] = seg.to[2]
				positions[i * 6 + 5] = -seg.to[1]
				rapid[i] = seg.rapid ? 1 : 0
				line[i] = seg.line
				time[i] = seg.t
				endOf.set(seg.line, {to: seg.to, rapid: seg.rapid})
				if (seg.rapid) continue
				cutSeen = true
			}
			grow(seg.from[0], seg.from[2], -seg.from[1])
			grow(seg.to[0], seg.to[2], -seg.to[1])
		}
		if (cutSeen) break
	}

	const centre: [number, number, number] = [
		(minX + maxX) / 2,
		(minY + maxY) / 2,
		(minZ + maxZ) / 2,
	]
	const radius = Math.max(1, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2)

	const labels: ToolpathLabel[] = []
	for (const [l, e] of endOf) {
		if (l % LABEL_EVERY !== 0) continue
		labels.push({
			line: l,
			text: lines[l] ?? '',
			position: [e.to[0], e.to[2], -e.to[1]],
			rapid: e.rapid,
		})
	}
	// Header lines (before the first move) stack at the start point.
	const first = tp.segments[0]
	for (let i = 0; i < first.line && i < 12; i++) {
		labels.push({
			line: -(first.line - i),
			text: lines[i] ?? '',
			position: [first.from[0], first.from[2], -first.from[1]],
			rapid: true,
		})
	}

	return {
		positions,
		rapid,
		line,
		time,
		labels,
		centre,
		radius,
		lineCount: lines.length,
		cutLength: tp.cutLength,
		seconds: tp.seconds,
	}
}

// Worker entry (a no-op when this module is imported on the main thread).
if (typeof self !== 'undefined' && typeof (self as any).importScripts === 'function') {
	self.onmessage = (e: MessageEvent<ParseRequest>) => {
		const {id, text} = e.data
		let result: CompactToolpath | null = null
		try {
			result = compactToolpath(text)
		} catch {
			result = null
		}
		const msg: ParseResponse = {id, result}
		if (result) {
			;(self as any).postMessage(msg, [
				result.positions.buffer,
				result.rapid.buffer,
				result.line.buffer,
				result.time.buffer,
			])
		} else {
			;(self as any).postMessage(msg)
		}
	}
}
