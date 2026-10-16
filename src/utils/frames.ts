/**
 * Insert / delete frames on ONE layer of the timeline.
 *
 * `komas[frame].shots[layer]` is the storage model: every layer shares the
 * frame numbering, but each is its own take, so inserting or deleting a frame
 * moves only that layer's shots — other layers, and anything keyed by frame
 * number elsewhere (addsub plans, G-code, the trash ledger), stay where they
 * are. (Until 2026-10-16 "Insert" spliced a koma into every layer at once, and
 * a 2-frame mis-click renamed 13 GB of files; see CLAUDE.md.)
 *
 * Pure functions over plain arrays so they can be unit-tested; the project
 * store wraps them and fixes up the capture cursor.
 */

export interface KomaLike<S> {
	shots: (S | null)[]
	backupShots?: unknown[]
}

function shotAt<S>(komas: KomaLike<S>[], frame: number, layer: number): S | null {
	return komas[frame]?.shots?.[layer] ?? null
}

// Skip writes that change nothing (and don't grow a short `shots` array just
// to store a null): the komas are reactive, and every real mutation makes the
// project's deep watchers walk the whole timeline again.
function setShotAt<S>(koma: KomaLike<S>, layer: number, shot: S | null) {
	if (layer >= koma.shots.length) {
		if (shot === null) return
		while (koma.shots.length <= layer) koma.shots.push(null)
	}
	if ((koma.shots[layer] ?? null) === shot) return
	koma.shots[layer] = shot
}

/** How many shots `layer` has at `frame` or later — what an insert there would move. */
export function shotsAtOrAfter<S>(komas: KomaLike<S>[], frame: number, layer: number): number {
	let n = 0
	for (let f = Math.max(0, frame); f < komas.length; f++) if (shotAt(komas, f, layer)) n++
	return n
}

/**
 * Open `count` empty frames on `layer` at `frame`: that layer's shots from
 * `frame` on move `count` frames later (komas are appended as needed). Returns
 * how many shots moved.
 */
export function insertFramesOnLayer<S, K extends KomaLike<S>>(
	komas: K[],
	frame: number,
	layer: number,
	makeKoma: () => K,
	count = 1
): number {
	if (count <= 0 || frame < 0) return 0
	let last = komas.length - 1
	while (last >= frame && !shotAt(komas, last, layer)) last--
	if (last < frame) return 0 // nothing on this layer from here on
	while (komas.length <= last + count) komas.push(makeKoma())
	let moved = 0
	for (let f = last; f >= frame; f--) {
		const shot = shotAt(komas, f, layer)
		if (shot) moved++
		setShotAt(komas[f + count], layer, shot)
		setShotAt(komas[f], layer, null)
	}
	return moved
}

/**
 * Remove `count` frames on `layer` starting at `frame`: the shots there are
 * taken out (and returned) and that layer's later shots move `count` frames
 * earlier. Komas left with nothing in any layer at the very end are dropped
 * (never below one koma). Returns the removed shots, in frame order.
 */
export function deleteFramesOnLayer<S, K extends KomaLike<S>>(
	komas: K[],
	frame: number,
	layer: number,
	count = 1
): (S | null)[] {
	if (count <= 0 || frame < 0 || frame >= komas.length) return []
	const removed: (S | null)[] = []
	for (let f = frame; f < frame + count; f++) removed.push(shotAt(komas, f, layer))
	for (let f = frame; f < komas.length; f++) {
		setShotAt(komas[f], layer, shotAt(komas, f + count, layer))
	}
	trimTrailingEmptyKomas(komas)
	return removed
}

/** Drop komas at the end that hold no shot in any layer (and no backups). */
export function trimTrailingEmptyKomas<S>(komas: KomaLike<S>[]): number {
	let dropped = 0
	while (komas.length > 1) {
		const k = komas[komas.length - 1]
		if (k.shots.some(Boolean) || k.backupShots?.length) break
		komas.pop()
		dropped++
	}
	return dropped
}
