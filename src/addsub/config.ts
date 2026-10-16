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
	icon: 'mdi:screw-machine-flat-top',
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
	// The dust collector's opto input hangs off the PiBot MOSFET output that
	// FluidNC drives as flood coolant (M8 / M9); the cut G-code switches it
	// too.
	panel: {
		outputs: {flood: 'Dust collector'},
	},
}

export const RIG_DEFINITION: MachineDefinition = {
	id: 'rig',
	label: 'Box Rig',
	icon: 'game-icons:mechanical-arm',
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
	// X Y Z / A B C in two rows; no feed input. Homing the linear axes lifts
	// Y (the hanging column) first, then X and Z together.
	panel: {
		gridColumns: 3,
		showFeed: false,
		homeGroups: [
			{label: 'XYZ', steps: ['y', ['x', 'z']]},
			{label: 'ABC', steps: ['a', 'b', 'c']},
		],
	},
}

//------------------------------------------------------------------------------
// LED wall (ADDSUB.md §3.3, §8). The placement itself is led/layout.ts.

export const LED_FACES = ['L', 'B', 'R', 'F'] as const
export type LedFace = (typeof LED_FACES)[number]

//------------------------------------------------------------------------------
// Box Rig travel, machine coordinates: X and Z run −550…+550 mm about the
// machine origin (centre of the frame), Y 0…−950 homed at the top and
// travelling negative (−900 until 2026-10-02).
export const RIG_LIMITS = {
	x: [-550, 550],
	y: [-950, 0],
	z: [-550, 550],
} as const satisfies Record<'x' | 'y' | 'z', readonly [number, number]>

/**
 * Where the mill parks for the shot, in its work coordinates (the G54 the
 * block was zeroed at): the table shifted 100 mm in mill Y so the block sits
 * clear of the spindle, head down at Z 0. The sequence's `extend` step goes
 * here (X/Y first, then Z) and `retract` returns the way it came (Z first).
 */
export const MILL_SHOOT_POSITION = {x: 0, y: 100, z: 0} as const

/**
 * Bump when the physical placement (led/layout.ts) changes; shots record the
 * version they were lit under. 2 = the Houdini set model (2026-10-16).
 */
export const LED_LAYOUT_VERSION = 2

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
	 * Rig machine coords = world + rigOffset: the machine position of the
	 * world origin. That origin is the rig's work origin (G54: the centre of
	 * the work's bottom face), so this follows the controller's work offset
	 * while the rig is connected (stores/rigWork.ts).
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
