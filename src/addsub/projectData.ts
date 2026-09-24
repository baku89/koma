/**
 * Per-project data for the work (ADDSUB.md §2, §7, §10, §12). Stored under
 * `project.addsub` in project.json; every field has a default so projects
 * saved before a field existed load fine (deep-merged with defaults on open).
 */

import type {AxesPosition} from '@/utils/fluidnc'

import {
	type AddsubCalibration,
	DEFAULT_CALIBRATION,
	DEFAULT_LED_LAYOUT,
	LED_LAYOUT_VERSION,
	type LedLayoutParams,
} from './config'

/** One step of the per-frame sequence, in order. §2 */
export const SEQUENCE_STEPS = [
	'cut',
	'spindleOff',
	'extend',
	'rig',
	'led',
	'settle',
	'capture',
	'park',
	'retract',
] as const

export type SequenceStep = (typeof SEQUENCE_STEPS)[number]

export const SEQUENCE_STEP_LABELS: Record<SequenceStep, string> = {
	cut: 'Cut (G-code)',
	spindleOff: 'Spindle off / retract',
	extend: 'Extend table to shoot position',
	rig: 'Move Box Rig',
	led: 'Set LEDs',
	settle: 'Settle',
	capture: 'Capture',
	park: 'Park reference shot',
	retract: 'Return table',
}

/**
 * Where the sequence was when it last ran, so a helper can resume after a
 * stop, a crash or a reload. Persisted with the project.
 */
export interface SequenceProgress {
	frame: number
	/** The step that was running (or about to run) when progress was saved. */
	step: SequenceStep
	/** Steps already completed for this frame. */
	done: SequenceStep[]
	status: 'running' | 'paused' | 'stopped' | 'error' | 'done'
	error?: string
	/** Mill table position before it was extended, to return to. */
	returnPosition?: {x: number; y?: number}
	updatedAt: number
}

export interface AddsubProjectData {
	/** Index of the lowest block on the mill (0 = block A). §7.1 */
	kBase: number
	/** previz frame number = timeline frame + this offset. */
	previzFrameOffset: number
	/** Mill table position (machine coords) for shooting. `y` optional. §2 */
	shootPosition: {x: number; y?: number}
	/**
	 * Table position to return to after the shot. Undefined = the position it
	 * was at before extending.
	 */
	cutPosition?: {x: number; y?: number}
	/** Mill Z (machine coords) the head must be at/above before extending. */
	millSafeZ: number
	/** Rig axes for the park reference frame (machine coords). null = none. */
	parkPose: AxesPosition | null
	/** Layer that park reference shots are written to. */
	parkLayer: number
	/** Whether to take a park reference shot every frame. */
	takeParkShot: boolean
	/** ms to wait after the rig stops before capturing. §2 step 6 */
	settleMs: number
	/** Feed for rig moves (mm/min). Rotary axes follow the same F word. */
	rigFeed: number
	/** Feed for the mill's extend/retract moves (mm/min). */
	millFeed: number
	/** Soft travel limits for the rig, checked before every move. */
	rigLimits: Partial<Record<keyof AxesPosition, [number, number]>>
	/** Skip the LED step when the wall isn't connected (instead of failing). */
	ledOptional: boolean
	calibration: AddsubCalibration
	led: {
		layout: LedLayoutParams
		layoutVersion: number
		/** Film Y (mm) at the top edge of the unwrapped LED images. */
		topFilmY: number
		/** 0–1 multiplier applied when sampling. */
		gain: number
		/** 0–1 brightness cap sent to the firmware on connect. */
		brightnessCap: number
	}
	sequence: SequenceProgress | null
}

export const DEFAULT_ADDSUB_DATA: AddsubProjectData = {
	kBase: 0,
	previzFrameOffset: 0,
	shootPosition: {x: 0},
	cutPosition: undefined,
	millSafeZ: 0,
	parkPose: null,
	parkLayer: 1,
	takeParkShot: false,
	settleMs: 2000,
	rigFeed: 1500,
	millFeed: 1000,
	rigLimits: {},
	ledOptional: true,
	calibration: DEFAULT_CALIBRATION,
	led: {
		layout: DEFAULT_LED_LAYOUT,
		layoutVersion: LED_LAYOUT_VERSION,
		topFilmY: DEFAULT_LED_LAYOUT.topY,
		gain: 1,
		brightnessCap: 0.8,
	},
	sequence: null,
}

/** What a shot records about the rig / mill / lighting it was taken with. */
export interface ShotMachineData {
	/** Rig axes (machine coords) at capture. */
	rig?: AxesPosition
	/** Mill axes (machine coords) at capture. */
	mill?: AxesPosition
	/** Base block index at capture. */
	kBase?: number
	/** Which lighting image was shown, and with which placement map. §8 */
	led?: {file: string; layoutVersion: number}
	/** previz frame this shot realises (may differ from the timeline frame). */
	previzFrame?: number
}
