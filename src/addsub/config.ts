/**
 * Work-specific constants for "Addition and Subtraction" (ADDSUB.md).
 * Anything that can change per installation is a *default* here and an
 * editable value in the project (see stores/addsub.ts); anything fixed by the
 * hardware build is a plain constant.
 */

import type {vec3} from 'linearly'

import type {MachineDefinition} from '@/stores/machine'

/** Target frame rate of the final film. */
export const FILM_FPS = 18

//------------------------------------------------------------------------------
// Machines (ADDSUB.md §3.1, §3.2). FluidNC `name:` values are what we match
// when a port is opened; they're overridable per-machine in the app config.

export const MILL_DEFINITION: MachineDefinition = {
	id: 'mill',
	label: 'Mill (AST200)',
	fluidncName: 'AST200',
	// Any Grbl/FluidNC board that isn't the Box Rig is the mill.
	fluidncFallback: true,
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
	// Work positions only, X Y Z / A B C in two rows; no feed input, no
	// "go to work 0" (the rig is driven in machine coordinates by the
	// sequence; work coordinates are just a jog reference).
	panel: {layout: 'grid', gridColumns: 3, showFeed: false, showGoToZero: false},
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
// Box Rig travel (2026-09-29): X and Z run −550…+550 mm about the machine
// origin (centre of the frame), Y 0…−900 homed at the top and travelling
// negative; with Y fully down the head sits ~400 mm high (tentative).
export const RIG_LIMITS = {
	x: [-550, 550],
	y: [-900, 0],
	z: [-550, 550],
} as const satisfies Record<'x' | 'y' | 'z', readonly [number, number]>
export const RIG_Y_DOWN_HEIGHT = 400

/** Bump when the physical placement changes so saved frames can be re-sampled. */
export const LED_LAYOUT_VERSION = 1

//------------------------------------------------------------------------------
// Calibration / placement (ADDSUB.md §3.0, §10, §12) — project-level
// defaults. All in mm / degrees, world = Y-up right-handed (previz).

export interface AddsubCalibration {
	/**
	 * Entrance pupil relative to the head's rotation centre, in camera
	 * coordinates (mm): X right, Y up, Z back — the lens looks down −Z, so a
	 * pupil d in front of the centre is (0, 0, −d). Side components catch a
	 * lens that isn't on the roll axis. (Was a scalar d until 2026-10-16;
	 * projectData.ts migrates it.)
	 */
	pupilOffset: vec3
	/**
	 * World position of the film origin (block A's bottom corner) with no
	 * blocks added underneath (filmLift = 0). Its Y is the mill table / vise
	 * floor height in world.
	 */
	rigOffset: vec3
	/**
	 * Machine angle of each rotary axis where the head looks straight (tilt,
	 * pan, roll = 0): the controller's work offset on A/B/C, followed like
	 * `rigOffset`.
	 */
	rotaryZero: {a: number; b: number; c: number}
	/**
	 * Sign of each rotary axis relative to the previz convention, to be
	 * confirmed on the machine (the head is mounted upside down). §10
	 */
	rotarySigns: {a: 1 | -1; b: 1 | -1; c: 1 | -1}
}

export const DEFAULT_CALIBRATION: AddsubCalibration = {
	pupilOffset: [0, 0, 0],
	// rig = world + offset. A placeholder until the rig's controller reports
	// its work offset (stores/rigWork.ts): X/Z at the centre of travel, the
	// work origin 1300 mm below the top of Y.
	rigOffset: [0, -1300, 0],
	rotaryZero: {a: 0, b: 0, c: 0},
	rotarySigns: {a: 1, b: 1, c: 1},
}
