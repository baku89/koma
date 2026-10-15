/**
 * Coordinate frames (ADDSUB.md §3.0).
 *
 * - world: the previz frame = the Box Rig's *work* coordinates. Y-up,
 *          right-handed, +X = R face, +Z = F face, origin at the centre of
 *          the work's bottom face (the rig's G54 zero, stores/rigWork.ts).
 *          Camera poses, plans, shot records and the LED placement are world.
 * - rig:   the Box Rig's machine coordinates = world + rigOffset (the
 *          controller's work offset).
 * - mill:  the mill keeps a conventional Z-up frame. It stands with its front
 *          facing −X, so its axes are a cyclic permutation of world's:
 *          world = (mill.y, mill.z, mill.x). Its work zero (G54, touched off
 *          by hand) is taken to be the world origin, so the mill's *work*
 *          coordinates map onto world with no offset — koma never sets or
 *          shifts the mill's work offset itself.
 */

import type {vec3} from 'linearly'

export function worldToRig(p: vec3, rigOffset: vec3): vec3 {
	return [p[0] + rigOffset[0], p[1] + rigOffset[1], p[2] + rigOffset[2]]
}

export function rigToWorld(p: vec3, rigOffset: vec3): vec3 {
	return [p[0] - rigOffset[0], p[1] - rigOffset[1], p[2] - rigOffset[2]]
}

/** Mill work frame (X right, Y back, Z up, as the mill sees it) → world. */
export function millToWorld(m: vec3): vec3 {
	return [m[1], m[2], m[0]]
}

/** world → mill work frame. Inverse of {@link millToWorld}. */
export function worldToMill(w: vec3): vec3 {
	return [w[2], w[0], w[1]]
}
