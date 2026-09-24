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
