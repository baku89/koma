/**
 * Coordinate frames (ADDSUB.md §3.0, §7.1).
 *
 * - world: previz frame. Y-up, right-handed. +X = R face, +Z = F face.
 * - film:  world shifted so block A's bottom corner is the origin and the
 *          stack grows *downward* as blocks are added underneath. Cutting
 *          paths, camera poses and LED images are stored in film coordinates
 *          so nothing has to be re-exported when a block is appended.
 * - rig:   the Box Rig's machine coordinates = world + rigOffset.
 * - mill:  the mill keeps a conventional Z-up frame. It stands with its front
 *          facing −X, so its axes are a cyclic permutation of world's:
 *          world = (mill.y, mill.z, mill.x) + millOffset.
 */

import {vec3} from 'linearly'

import type {AxesPosition} from '@/utils/fluidnc'

/**
 * film → world. `lift` (mm) is how far the film frame has risen above its
 * original place: the summed height of the blocks glued under block A (§7.1).
 * world Y = film Y + filmOriginWorld.y + lift.
 */
export function filmToWorld(p: vec3, lift: number, filmOriginWorld: vec3): vec3 {
	return vec3.add(p, filmOriginWorld, [0, lift, 0])
}

export function worldToFilm(p: vec3, lift: number, filmOriginWorld: vec3): vec3 {
	return vec3.sub(p, filmOriginWorld, [0, lift, 0])
}

export function worldToRig(p: vec3, rigOffset: vec3): vec3 {
	return vec3.add(p, rigOffset)
}

export function rigToWorld(p: vec3, rigOffset: vec3): vec3 {
	return vec3.sub(p, rigOffset)
}

/** Mill table frame (X right, Y back, Z up, as the mill sees it) → world. */
export function millToWorld(m: vec3, millOffset: vec3): vec3 {
	return vec3.add([m[1], m[2], m[0]], millOffset)
}

/** world → mill table frame. Inverse of {@link millToWorld}. */
export function worldToMill(w: vec3, millOffset: vec3): vec3 {
	const p = vec3.sub(w, millOffset)
	return [p[2], p[0], p[1]]
}

/**
 * The mill moves its *table* in X/Y (the head only moves in Z). Its MPos is
 * the tool position in the table frame, so when the table is driven away
 * from the calibrated shoot position by Δ, the block moves by −Δ in world.
 */
export function tableShiftWorld(
	mpos: AxesPosition,
	shootPosition: {x: number; y?: number}
): vec3 {
	const dx = (mpos.x ?? shootPosition.x) - shootPosition.x
	const dy =
		shootPosition.y === undefined ? 0 : (mpos.y ?? shootPosition.y) - shootPosition.y
	// mill +X → world +Z, mill +Y → world +X
	return [-dy, 0, -dx]
}

/**
 * Where the film origin is in the mill's machine coordinates for the current
 * lift — what `G10 L2 P1` should be set to before streaming a frame's G-code
 * (§7.1). Appending a block raises it by that block's height.
 */
export function filmOriginMill(
	lift: number,
	filmOriginWorld: vec3,
	millOffset: vec3
): vec3 {
	return worldToMill(filmToWorld([0, 0, 0], lift, filmOriginWorld), millOffset)
}
