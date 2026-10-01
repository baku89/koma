/**
 * Per-project data for the work (ADDSUB.md §2, §7, §10, §12). Stored under
 * `project.addsub` in project.json; every field has a default so projects
 * saved before a field existed load fine (deep-merged with defaults on open).
 */

import type {AxesPosition} from '@/utils/fluidnc'

import {
	type AddsubCalibration,
	DEFAULT_BLOCK_HEIGHT,
	DEFAULT_CALIBRATION,
	DEFAULT_LED_LAYOUT,
	LED_LAYOUT_VERSION,
	type LedFace,
	type LedLayoutParams,
	RIG_LIMITS,
} from './config'
import type {PlanTable} from './plan'

/** One step of the per-frame sequence, in order. §2 */
export const SEQUENCE_STEPS = [
	'cut',
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
export type SequenceMode = 'shoot' | 'replay'

/** Steps of a replay pass (§7.2): no cutting, no table moves. */
export const REPLAY_STEPS: readonly SequenceStep[] = ['rig', 'led', 'settle', 'capture']

export interface SequenceProgress {
	/** 'shoot' (default) = the normal per-frame sequence; 'replay' = §7.2 pass. */
	mode?: SequenceMode
	/** Replay: inclusive frame range being re-shot. */
	range?: [number, number]
	/** Replay: id of the layer this pass shoots into. */
	replayLayerId?: string
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

// Cuts (cuts.ts): the types live here so project.ts → projectData → cuts →
// project.ts doesn't form a type cycle.
export interface CutRun {
	startedAt: number
	/** Wall-clock time from the first line sent to the mill going Idle. */
	durationMs: number
	/** Lines sent (all of them when `done`). */
	linesSent: number
	total: number
	/** Ran to the end (the mill went Idle after the last line). */
	done: boolean
	error?: string
	/** Film lift (mm) the G54 origin was set for. */
	filmLift: number
	/** The parser's estimate (s) for this file, for calibrating later ETAs. */
	estimatedSec?: number
}

export interface FrameCut {
	/**
	 * `file`: dropped on the timeline, `file` is under `gcode/`.
	 * `previz`: planned by previz/frames.json; the record exists only to hold
	 * the run (the path is re-resolved from previz each time).
	 */
	source: 'file' | 'previz'
	/** Path relative to the project folder. */
	file: string
	/** The name the operator knows it by (the dropped file's name). */
	name: string
	addedAt: number
	/** Line count after stripping comments / blanks. */
	lines?: number
	/** Parser estimate (s), no acceleration. */
	estimatedSec?: number
	/** The last run of this file. Null / missing = never run. */
	run?: CutRun | null
}

/** layer id → timeline frame → cut. Sparse. */
export type CutTable = Record<string, Record<number, FrameCut>>

export interface AddsubProjectData {
	/**
	 * How far the film frame has risen above its original place (mm): the
	 * summed height of the blocks glued under block A so far. world Y = film Y
	 * + filmOriginWorld.y + filmLift. §7.1
	 */
	filmLift: number
	/** Height (mm) of the next block to append — the default for the prompt. */
	blockHeight: number
	/** previz frame number = timeline frame + this offset. */
	previzFrameOffset: number
	/** Mill table position (machine coords) for shooting. `y` optional. §2 */
	shootPosition: {x: number; y?: number}
	/**
	 * Table position to return to after the shot. Undefined = the position it
	 * was at before extending.
	 */
	cutPosition?: {x: number; y?: number}
	/** Rig axes for the park reference frame (machine coords). null = none. */
	parkPose: AxesPosition | null
	/** Layer (id) park reference shots go to. null = create "Park" on first use. */
	parkLayerId: string | null
	/** Whether to take a park reference shot every frame. */
	takeParkShot: boolean
	/**
	 * ms to wait after the rig stops before capturing — always waited in full.
	 * §2 step 6
	 */
	settleMs: number
	/**
	 * After `settleMs`, keep waiting until the live view has stopped moving
	 * (motion.ts), so a long move that leaves the camera swinging gets the
	 * time it needs and a short one does not wait for nothing.
	 */
	settleStill: boolean
	/** The longest the settle step waits for stillness (ms); then it shoots. */
	settleMaxMs: number
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
		/** Manual per-face colours (hex), for the "Faces" light mode. */
		faceColors: Record<LedFace, string>
	}
	sequence: SequenceProgress | null
	/** Per-frame shooting plans, by layer id then timeline frame (plan.ts). §13 */
	plan: PlanTable
	/**
	 * How far the rig may sit from the capture frame's planned pose and still
	 * pass the shoot condition (Grbl reports the commanded, step-quantised
	 * position, so "exact" is never quite exact): mm for X/Y/Z, degrees for
	 * A/B/C.
	 */
	planTolerance: {linear: number; rotary: number}
	/**
	 * Per-layer G-code, for takes that were cut with their own files (e.g.
	 * imported test shoots): layer id → path pattern relative to the project
	 * folder, `%04d` = the layer's frame. The film's own cuts come from
	 * previz/frames.json instead.
	 */
	layerGcode?: Record<string, string>
	/**
	 * After a manual shot, the rig moves by itself to the next frame's planned
	 * pose if that is less than this far away (mm, straight line in X/Y/Z).
	 * Further than that it stays put and the move is the operator's to make
	 * ("Go to Plan"). 0 = never move by itself.
	 */
	autoMoveMaxDistance: number
	/**
	 * G-code attached to frames by hand (dropped on the timeline) and the
	 * record of every cut run, by layer id then timeline frame (cuts.ts).
	 */
	cuts: CutTable
	/**
	 * Refuse the shutter while the capture frame has G-code that hasn't been
	 * run to the end (shoot condition). Off for dry runs without the mill.
	 */
	requireCut: boolean
	/**
	 * Before each cut, overwrite the mill's G54 origin with the film origin
	 * (`G10 L2 P1`, from `calibration.millOffset` and `filmLift`; §7.1). Off =
	 * the G-code runs in whatever work zero is set on the machine, as any
	 * sender would. Only turn it on once `millOffset` is calibrated: with the
	 * placeholder offset it points G54 at the machine origin.
	 */
	cutSetsWorkOffset: boolean
	/** Rapid rate (mm/min) assumed by the cut time estimate. */
	millRapidFeed: number
}

export const DEFAULT_ADDSUB_DATA: AddsubProjectData = {
	filmLift: 0,
	blockHeight: DEFAULT_BLOCK_HEIGHT,
	previzFrameOffset: 0,
	shootPosition: {x: 0},
	cutPosition: undefined,
	parkPose: null,
	parkLayerId: null,
	takeParkShot: false,
	settleMs: 2000,
	settleStill: true,
	settleMaxMs: 20000,
	rigFeed: 1500,
	millFeed: 1000,
	rigLimits: {x: [...RIG_LIMITS.x], y: [...RIG_LIMITS.y], z: [...RIG_LIMITS.z]},
	ledOptional: true,
	calibration: DEFAULT_CALIBRATION,
	led: {
		layout: DEFAULT_LED_LAYOUT,
		layoutVersion: LED_LAYOUT_VERSION,
		topFilmY: DEFAULT_LED_LAYOUT.topY,
		gain: 1,
		brightnessCap: 0.8,
		faceColors: {L: '#ffffff', B: '#ffffff', R: '#ffffff', F: '#ffffff'},
	},
	sequence: null,
	plan: {},
	planTolerance: {linear: 0.2, rotary: 0.1},
	autoMoveMaxDistance: 100,
	cuts: {},
	requireCut: true,
	cutSetsWorkOffset: false,
	millRapidFeed: 1500,
}

/** What a shot records about the LED wall it was lit with. */
export interface ShotLedRecord {
	/**
	 * The lighting image (relative to previz/) that was on the wall. Missing
	 * when the light didn't come from one (faces, live feed, manual fill).
	 */
	file?: string
	/** Placement map the wall was laid out with. */
	layoutVersion: number
	/**
	 * Every pixel's RGB as sent to the wall (led/wallRecord.ts), relative to
	 * the project folder. Only recorded while the wall was connected.
	 */
	wall?: string
	/** Firmware brightness cap (0–1) in force. */
	brightnessCap?: number
}

/** What a shot records about the rig / mill / lighting it was taken with. */
export interface ShotMachineData {
	/** Rig axes (machine coords) at capture. */
	rig?: AxesPosition
	/** Mill axes (machine coords) at capture. */
	mill?: AxesPosition
	/** Film lift (mm, see AddsubProjectData.filmLift) at capture. */
	filmLift?: number
	/** The lighting at capture. §8 */
	led?: ShotLedRecord
	/** previz frame this shot realises (may differ from the timeline frame). */
	previzFrame?: number
	/** The cut that preceded this shot (cuts.ts), when one was run. */
	cut?: {file: string; durationMs: number}
}

//------------------------------------------------------------------------------
// Migration

/** Block height the retired integer `kBase` (base block index) stood for. */
const LEGACY_BLOCK_HEIGHT = 60

/**
 * Upgrade a loaded project in place from the `kBase` era (lift = 60·kBase, all
 * blocks 60 mm) to `filmLift` (mm). Idempotent: files already on `filmLift`
 * are untouched.
 */
type LegacyShot = ShotMachineData & {kBase?: number}

export function migrateAddsubData(project: {
	addsub: AddsubProjectData & {kBase?: number}
	komas: ({shots: (LegacyShot | null | undefined)[]} | null | undefined)[]
	trash?: {shot: LegacyShot}[]
}) {
	const a = project.addsub
	// 2026-09-29: the rig's travel was re-measured (X/Z ±550 about the centre,
	// not 0…1200). Projects still carrying the old placeholder defaults get
	// the new ones; anything the user edited is left alone.
	const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y)
	if (same(a.rigLimits, {x: [0, 1200], y: [-900, 0], z: [0, 1200]})) {
		a.rigLimits = {x: [...RIG_LIMITS.x], y: [...RIG_LIMITS.y], z: [...RIG_LIMITS.z]}
	}
	if (a.calibration && same(a.calibration.rigOffset, [-600, -1300, -600])) {
		a.calibration.rigOffset = [...DEFAULT_CALIBRATION.rigOffset] as typeof a.calibration.rigOffset
	}
	if (a.kBase !== undefined) {
		if (a.filmLift === undefined || a.filmLift === 0) a.filmLift = LEGACY_BLOCK_HEIGHT * a.kBase
		delete a.kBase
	}
	const shots: LegacyShot[] = []
	for (const koma of project.komas) {
		for (const shot of koma?.shots ?? []) if (shot) shots.push(shot)
	}
	for (const t of project.trash ?? []) shots.push(t.shot)
	for (const shot of shots) {
		if (shot.kBase === undefined) continue
		shot.filmLift ??= LEGACY_BLOCK_HEIGHT * shot.kBase
		delete shot.kBase
	}
}
