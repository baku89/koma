/**
 * Small G-code string builders shared by jog UIs and shot sequencers.
 */

import {AXES, type AxesPosition,type Axis} from './status'

/** Format a coordinate for G-code: no exponent, trailing zeros trimmed. */
export function fmtNum(n: number, precision = 4): string {
	if (!Number.isFinite(n)) throw new Error(`Non-finite coordinate: ${n}`)
	const s = n.toFixed(precision)
	return s.replace(/\.?0+$/, '').replace(/^-0$/, '0') || '0'
}

/** `{x: 1, a: 90}` → `X1 A90` (axes in canonical order, undefined skipped). */
export function axesWords(axes: AxesPosition, precision?: number): string {
	return AXES.filter(a => axes[a] !== undefined)
		.map(a => `${a.toUpperCase()}${fmtNum(axes[a] as number, precision)}`)
		.join(' ')
}

export interface JogOptions {
	/** mm/min (or deg/min for rotary axes). Required by `$J=`. */
	feed: number
	/** Relative (G91, default) or absolute (G90) target. */
	relative?: boolean
	/** Use machine coordinates (G53). Only meaningful with `relative: false`. */
	machineCoords?: boolean
}

/**
 * Build a `$J=` jog line. Jogs don't alter the parser's modal state and can be
 * cancelled at any time with the 0x85 realtime byte.
 */
export function jogLine(axes: AxesPosition, opts: JogOptions): string {
	const words = axesWords(axes)
	if (!words) throw new Error('jogLine: no axes given')
	const mode = opts.relative === false ? 'G90' : 'G91'
	const g53 = opts.relative === false && opts.machineCoords ? ' G53' : ''
	return `$J=${mode}${g53} G21 ${words} F${fmtNum(opts.feed)}`
}

/** `G0`/`G1` move line in absolute machine coordinates (G53 G90). */
export function machineMoveLine(
	axes: AxesPosition,
	feed?: number,
	precision?: number
): string {
	const words = axesWords(axes, precision)
	if (!words) throw new Error('machineMoveLine: no axes given')
	return feed === undefined
		? `G53 G0 ${words}`
		: `G53 G1 ${words} F${fmtNum(feed)}`
}

/** `G10 L2 P<n> ...` — set a work coordinate system origin (machine coords). */
export function setWorkOffsetLine(
	slot: 1 | 2 | 3 | 4 | 5 | 6,
	origin: AxesPosition
): string {
	return `G10 L2 P${slot} ${axesWords(origin)}`
}

/**
 * Split raw G-code text into sendable lines: strips comments (`;` and `(...)`),
 * whitespace and blank lines, keeps the original 1-based line numbers so
 * progress can be reported against the source file.
 */
export function prepareGCode(
	text: string
): {line: string; sourceLine: number}[] {
	const out: {line: string; sourceLine: number}[] = []
	text.split(/\r?\n/).forEach((raw, i) => {
		const line = raw
			.replace(/\(.*?\)/g, '')
			.replace(/;.*$/, '')
			.trim()
		if (line && line !== '%') out.push({line, sourceLine: i + 1})
	})
	return out
}

export function isAxis(s: string): s is Axis {
	return (AXES as readonly string[]).includes(s)
}

/**
 * Re-express the axis words of a typed move in another coordinate frame.
 * For an absolute move with axis words — a `G0` / `G1` / `$J=` line, or a
 * bare `Z0` / `X10 Y20 F500` that rides on the modal motion mode — `convert`
 * maps the words (the axes given, in the frame they were typed in) to
 * machine coordinates, and the line comes back with those words and a G53.
 * Lines that are relative (G91), already machine (G53), or carry any other
 * G / M command (G10, G28, G92, M3…) are returned as typed.
 */
export function rewriteMoveLine(
	line: string,
	convert: (axes: AxesPosition) => AxesPosition
): string {
	const upper = line.trim().toUpperCase()
	if (!upper || /\bG53\b|\bG91\b/.test(upper)) return line
	const jog = upper.startsWith('$J=')
	let body = jog ? upper.slice(3) : upper
	if (!jog && !isMotionLine(body)) return line
	const axes: AxesPosition = {}
	body = body.replace(/(^|\s)([XYZABC])(-?\d*\.?\d+)(?=\s|$)/g, (_m, pre, letter, value) => {
		axes[letter.toLowerCase() as Axis] = Number(value)
		return pre
	})
	if (Object.keys(axes).length === 0) return line
	const words = axesWords(convert(axes))
	if (!words) return line
	body = body.replace(/\s+/g, ' ').trim()
	if (jog) {
		// `$J=G90 G53 G21 … F…` — G90 is required for a G53 jog.
		if (!/\bG90\b/.test(body)) body = `G90 ${body}`
		return `$J=${body.replace(/\bG90\b/, 'G90 G53')} ${words}`.replace(/\s+/g, ' ')
	}
	// `G53 G0 …`: G53 is non-modal and must come before the G0 / G1 of the
	// line (or stand alone with the modal G0 / G1 for a bare `Z0`).
	return `G53 ${body} ${words}`.replace(/\s+/g, ' ')
}

/**
 * A line that moves along G0 / G1: either names one, or is only axis words
 * (plus F / S and the harmless G90 / G20 / G21 / G94) so the modal motion
 * mode applies. Any other G or M word (G10, G28, G92, M3…) means something
 * else is going on and the axis words are not a destination.
 */
function isMotionLine(body: string): boolean {
	if (/(^|\s)G0?[01](\s|$)/.test(body)) return true
	const others = body.match(/(^|\s)[GM]\d+(\.\d+)?(?=\s|$)/g) ?? []
	return others.every(w => /^\s?G(90|20|21|94)$/.test(w))
}
