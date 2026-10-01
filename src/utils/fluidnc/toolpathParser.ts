/**
 * Main-thread client of toolpath.worker.ts: parse G-code text into a
 * CompactToolpath without blocking the page. Falls back to parsing inline
 * when workers are unavailable. Results are cached per key (the file path)
 * so a looping screen doesn't re-parse the same cut every lap.
 */

import {
	type CompactToolpath,
	compactToolpath,
	type ParseRequest,
	type ParseResponse,
} from './toolpath.worker'

const CACHE_LIMIT = 60

let worker: Worker | null | undefined
let nextId = 1
const pending = new Map<number, (r: CompactToolpath | null) => void>()
const cache = new Map<string, Promise<CompactToolpath | null>>()

function getWorker(): Worker | null {
	if (worker !== undefined) return worker
	try {
		worker = new Worker(new URL('./toolpath.worker.ts', import.meta.url), {type: 'module'})
		worker.onmessage = (e: MessageEvent<ParseResponse>) => {
			const resolve = pending.get(e.data.id)
			if (!resolve) return
			pending.delete(e.data.id)
			resolve(e.data.result)
		}
		worker.onerror = () => {
			// Fall back to inline parsing from now on; settle what's in flight.
			for (const resolve of pending.values()) resolve(null)
			pending.clear()
			worker?.terminate()
			worker = null
		}
	} catch {
		worker = null
	}
	return worker
}

function parseText(text: string): Promise<CompactToolpath | null> {
	const w = getWorker()
	if (!w) return Promise.resolve(compactToolpath(text))
	return new Promise(resolve => {
		const id = nextId++
		pending.set(id, resolve)
		const msg: ParseRequest = {id, text}
		w.postMessage(msg)
	})
}

/**
 * Parse (or reuse) the toolpath for `key`, reading the text with `load` only
 * on a miss. A null result (no moves / unreadable) is cached too.
 */
export function parseToolpathCached(
	key: string,
	load: () => Promise<string | null>
): Promise<CompactToolpath | null> {
	const hit = cache.get(key)
	if (hit) {
		// Refresh LRU order.
		cache.delete(key)
		cache.set(key, hit)
		return hit
	}
	const p = (async () => {
		const text = await load()
		if (!text) return null
		return parseText(text)
	})()
	cache.set(key, p)
	while (cache.size > CACHE_LIMIT) {
		const oldest = cache.keys().next().value as string
		cache.delete(oldest)
	}
	return p
}

export function clearToolpathCache() {
	cache.clear()
}

/**
 * Estimated seconds already accounted for once `sentLines` lines have been
 * sent (the end of the last segment those lines produced), and the seconds
 * that remain. Segments come in source order, so a binary search on the line
 * index finds the boundary.
 */
export function toolpathTimeAt(tp: CompactToolpath, sentLines: number): {elapsed: number; remaining: number} {
	let lo = 0
	let hi = tp.line.length
	while (lo < hi) {
		const mid = (lo + hi) >> 1
		if (tp.line[mid] < sentLines) lo = mid + 1
		else hi = mid
	}
	const elapsed = lo === 0 ? 0 : tp.time[lo - 1]
	return {elapsed, remaining: Math.max(0, tp.seconds - elapsed)}
}
