/**
 * Work-specific constants for "Addition and Subtraction" (ADDSUB.md).
 * Anything that can change per installation is a *default* here and an
 * editable value in the project (see stores/addsub.ts); anything fixed by the
 * hardware build is a plain constant.
 */

import type {vec3} from 'linearly'

import type {MachineDefinition} from '@/stores/machine'

/** Block height (mm), all blocks are cut to this. ADDSUB.md §7 */
export const BLOCK_HEIGHT = 60

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
		x: {unit: 'mm', label: 'X (gantry)'},
		y: {unit: 'mm', label: 'Y (vertical)'},
		z: {unit: 'mm', label: 'Z (carriage)'},
		a: {unit: 'deg', label: 'A (tilt)'},
		b: {unit: 'deg', label: 'B (pan)'},
		c: {unit: 'deg', label: 'C (roll)'},
	},
	jogFeed: 1500,
}

//------------------------------------------------------------------------------
// LED wall (ADDSUB.md §3.3, §8). Geometry that isn't derivable from the
// firmware's INFO reply. Values marked (assumed) must be confirmed on site.

export const LED_FACES = ['L', 'B', 'R', 'F'] as const
export type LedFace = (typeof LED_FACES)[number]

export interface LedLayoutParams {
	/** Width of one face of the wall (mm). (assumed = rig cube) */
	faceWidth: number
	/** Length of one strip (mm). */
	stripLength: number
	/** Pixels on one strip. */
	pixelsPerStrip: number
	/** Strips per data line (max 10). */
	stripsPerLine: number
	/** Vertical distance between strips (mm). */
	stripSpacing: number
	/**
	 * World Y (mm) of the topmost strip. Two lines per face stack downward
	 * from here. (assumed — measure on site)
	 */
	topY: number
	/**
	 * Which end the first strip of every line starts from, as seen from the
	 * inside of the wall facing that face. (assumed)
	 */
	startSide: 'left' | 'right'
}

export const DEFAULT_LED_LAYOUT: LedLayoutParams = {
	faceWidth: 1500,
	stripLength: 1400,
	pixelsPerStrip: 42,
	stripsPerLine: 10,
	stripSpacing: 100,
	topY: 1500,
	startSide: 'left',
}

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
	 * World position of the film origin (block A's bottom corner) when
	 * k_base = 0. Its Y is the mill table / vise floor height in world.
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
	rigOffset: [0, 0, 0],
	millOffset: [0, 0, 0],
	rotarySigns: {a: 1, b: 1, c: 1},
}
