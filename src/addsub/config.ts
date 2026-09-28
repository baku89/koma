/**
 * Work-specific constants for "Addition and Subtraction" (ADDSUB.md).
 * Anything that can change per installation is a *default* here and an
 * editable value in the project (see stores/addsub.ts); anything fixed by the
 * hardware build is a plain constant.
 */

import type {vec3} from 'linearly'

import type {MachineDefinition} from '@/stores/machine'

/**
 * Nominal block height (mm): the default for "Append block" and the display
 * cube. Blocks need not all be this tall — what the coordinates use is the
 * project's `filmLift`, the summed height of the blocks added under A. §7
 */
export const DEFAULT_BLOCK_HEIGHT = 60

/** Max stack on the mill table: two blocks. */
export const MILL_MAX_HEIGHT = 100

/** Target frame rate of the final film. */
export const FILM_FPS = 18

//------------------------------------------------------------------------------
// Machines (ADDSUB.md §3.1, §3.2). FluidNC `name:` values are what we match
// when a port is opened; they're overridable per-machine in the app config.

export const MILL_DEFINITION: MachineDefinition = {
	id: 'mill',
	label: 'Mill (AST200)',
	fluidncName: 'AST200',
	axes: ['x', 'y', 'z'],
	axisInfo: {
		x: {unit: 'mm'},
		y: {unit: 'mm'},
		z: {unit: 'mm'},
	},
	jogFeed: 800,
}

export const RIG_DEFINITION: MachineDefinition = {
	id: 'rig',
	label: 'Box Rig',
	fluidncName: 'BoxRig',
	axes: ['x', 'y', 'z', 'a', 'b', 'c'],
	axisInfo: {
		x: {unit: 'mm'},
		y: {unit: 'mm'},
		z: {unit: 'mm'},
		a: {unit: 'deg'},
		b: {unit: 'deg'},
		c: {unit: 'deg'},
	},
	jogFeed: 1500,
}

//------------------------------------------------------------------------------
// LED wall (ADDSUB.md §3.3, §8). Geometry that isn't derivable from the
// firmware's INFO reply. Values marked (assumed) must be confirmed on site.

export const LED_FACES = ['L', 'B', 'R', 'F'] as const
export type LedFace = (typeof LED_FACES)[number]

export interface LedLayoutParams {
	/** Inner size of the wall along world X (B/F faces run this long), mm. */
	sizeX: number
	/** Inner size along world Z (L/R faces run this long), mm. */
	sizeZ: number
	/** Wall height = strip length (the 1400 mm strips stand vertically), mm. */
	height: number
	/** Pixels on one strip. */
	pixelsPerStrip: number
	/** Strips per data line (firmware max 10). */
	stripsPerLine: number
	/** Horizontal distance between strips (mm). */
	stripSpacing: number
	/** World Y of the top of the strips. */
	topY: number
	/**
	 * Which end each face's first strip stands at, as seen from the inside
	 * facing that face; strips snake left↔right from there. (assumed)
	 */
	startSide: 'left' | 'right'
}

/** Measured 2026-09-25: LED wall 1831 (X) × 1400 (Y) × 1991 (Z). */
export const DEFAULT_LED_LAYOUT: LedLayoutParams = {
	sizeX: 1831,
	sizeZ: 1991,
	height: 1400,
	pixelsPerStrip: 42,
	stripsPerLine: 10,
	stripSpacing: 100,
	topY: 1400,
	startSide: 'left',
}

//------------------------------------------------------------------------------
// Box Rig travel (2026-09-25): X and Z 1200 mm, Y 900 mm homed at the top and
// travelling negative; with Y fully down the head sits ~400 mm high (tentative).
export const RIG_TRAVEL = {x: 1200, y: 900, z: 1200} as const
export const RIG_Y_DOWN_HEIGHT = 400

/** Bump when the physical placement changes so saved frames can be re-sampled. */
export const LED_LAYOUT_VERSION = 1

//------------------------------------------------------------------------------
// Calibration / placement (ADDSUB.md §3.0, §7.1, §10, §12) — project-level
// defaults. All in mm / degrees, world = Y-up right-handed (previz).

export interface AddsubCalibration {
	/**
	 * Entrance-pupil offset along the optical axis from the head's rotation
	 * centre (mm). o = (0, 0, −d); d > 0 = pupil in front of the centre.
	 */
	pupilOffset: number
	/**
	 * World position of the film origin (block A's bottom corner) with no
	 * blocks added underneath (filmLift = 0). Its Y is the mill table / vise
	 * floor height in world.
	 */
	filmOriginWorld: vec3
	/** Rig machine coords = world + rigOffset. Ideally ≈ 0 after homing setup. */
	rigOffset: vec3
	/**
	 * Mill table frame → world: world = cycle(millTable) + millOffset, valid
	 * with the table at the shoot position (§3.0, §12 step 3).
	 */
	millOffset: vec3
	/**
	 * Sign of each rotary axis relative to the previz convention, to be
	 * confirmed on the machine (the head is mounted upside down). §10
	 */
	rotarySigns: {a: 1 | -1; b: 1 | -1; c: 1 | -1}
}

export const DEFAULT_CALIBRATION: AddsubCalibration = {
	pupilOffset: 0,
	filmOriginWorld: [0, 0, 0],
	// rig = world + offset. X/Z: travel centre assumed at world origin. Y: at
	// machine Y = −900 (fully down) the head is RIG_Y_DOWN_HEIGHT high:
	// −900 = 400 + offsetY.
	rigOffset: [-RIG_TRAVEL.x / 2, -RIG_TRAVEL.y - RIG_Y_DOWN_HEIGHT, -RIG_TRAVEL.z / 2],
	millOffset: [0, 0, 0],
	rotarySigns: {a: 1, b: 1, c: 1},
}
