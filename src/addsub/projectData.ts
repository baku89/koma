/**
 * Per-project data for the work (ADDSUB.md §2, §7, §10, §12). Stored under
 * `project.addsub` in project.json; every field has a default so projects
 * saved before a field existed load fine (deep-merged with defaults on open).
 */

import type {AxesPosition} from '@/utils/fluidnc'

import {
	type AddsubCalibration,
	DEFAULT_CALIBRATION,
	type LedFace,
	RIG_LIMITS,
} from './config'
import {DEFAULT_LENS_CALIBRATION, type FocusMode, type LensCalibration} from './lens'
import type {PlanTable} from './plan'

/**
 * One step of the per-frame sequence, in order. §2. The rig and the wall go
 * first (concurrently): the camera is in place before the cut starts, so by
 * the time the table is out again it has long stopped swinging, and the
 * operator can touch up the angle / focus while cleaning up after the cut.
 */
export const SEQUENCE_STEPS = [
	'rig',
	'led',
	'cut',
	'extend',
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
export interface SequenceProgress {
	/** A run over in → out: the inclusive frame range being shot. */
	range?: [number, number]
	frame: number
	/** The step that was running (or about to run) when progress was saved. */
	step: SequenceStep
	/** Steps already completed for this frame. */
	done: SequenceStep[]
	status: 'running' | 'paused' | 'stopped' | 'error' | 'done'
	error?: string
	/**
	 * Mill work position before `extend` moved it to the shoot position, to
	 * return to in `retract`. Y/Z are missing on progress saved before
	 * 2026-10-16, when only X moved.
	 */
	returnPosition?: {x: number; y?: number; z?: number}
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
	/** Runs before 2026-10-16 recorded the film lift the G54 origin was set for. */
	filmLift?: number
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

/**
 * A G-code file kept in the project to be attached to any frame later (the
 * Cut tab's Presets): a copy under `gcode/_presets/`.
 */
export interface CutPreset {
	/** Path relative to the project folder. */
	file: string
	/** The dropped file's name; unique among the presets. */
	name: string
	addedAt: number
	lines?: number
	estimatedSec?: number
}

/** layer id → timeline frame → cut. Sparse. */
export type CutTable = Record<string, Record<number, FrameCut>>

export interface AddsubProjectData {
	/**
	 * The coordinates stored rig axes are in — plans, shot records, the park
	 * pose: the rig's work coordinates (G54), what people read and type. A
	 * file without this holds machine coordinates (before 2026-10-02) and is
	 * converted when it is opened.
	 */
	rigStorage: 'work'
	/**
	 * Left by that conversion: the work offset it used has not been confirmed
	 * by the controller. On the controller's first report the stored axes are
	 * re-based to its real offset, so they stay where they physically were
	 * (stores/rigWork.ts).
	 */
	rigRebase?: boolean
	/** previz frame number = timeline frame + this offset. */
	previzFrameOffset: number
	/** Rig axes for the park reference frame (work coords). null = none. */
	parkPose: AxesPosition | null
	/** Layer (id) park reference shots go to. null = create "Park" on first use. */
	parkLayerId: string | null
	/** The point (work coords, mm) the "aim camera" command last aimed at. */
	aimTarget: [number, number, number]
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
	/** Soft travel limits for the rig, checked before every move. */
	rigLimits: Partial<Record<keyof AxesPosition, [number, number]>>
	calibration: AddsubCalibration
	/** The lens's focus ↔ distance ↔ field-of-view table (lens.ts). */
	lens: LensCalibration
	/**
	 * How the focus is set (Camera Control › Lens):
	 *   normalized  the camera's own 0–1 position, typed in Camera Control
	 *   distance    millimetres from the head's rotation centre, through the
	 *               lens table (lens.ts)
	 *   target      kept on `target` (work coordinates, mm) from wherever the
	 *               rig is, through the lens table — auto focus
	 */
	focus: {mode: FocusMode; target: [number, number, number]}
	led: {
		/** Multiplier on per-pixel colours pushed in (the live feed). */
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
	/** G-code presets (Cut tab), in the order they were added. */
	cutPresets?: CutPreset[]
	/**
	 * Refuse the shutter while the capture frame has G-code that hasn't been
	 * run to the end (shoot condition). Off for dry runs without the mill.
	 */
	requireCut: boolean
	/** Rapid rate (mm/min) assumed by the cut time estimate. */
	millRapidFeed: number
}

export const DEFAULT_ADDSUB_DATA: AddsubProjectData = {
	rigStorage: 'work',
	previzFrameOffset: 0,
	parkPose: null,
	parkLayerId: null,
	aimTarget: [0, 0, 0],
	takeParkShot: false,
	settleMs: 2000,
	settleStill: true,
	settleMaxMs: 20000,
	rigFeed: 1500,
	rigLimits: {x: [...RIG_LIMITS.x], y: [...RIG_LIMITS.y], z: [...RIG_LIMITS.z]},
	calibration: DEFAULT_CALIBRATION,
	lens: DEFAULT_LENS_CALIBRATION,
	focus: {mode: 'normalized', target: [0, 0, 0]},
	led: {
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
	millRapidFeed: 1500,
}

/** What a shot records about the LED wall it was lit with. */
export interface ShotLedRecord {
	/** Placement map the wall was laid out with. */
	layoutVersion: number
	/**
	 * Every pixel's RGB as sent to the wall (led/wallRecord.ts), relative to
	 * the project folder. Missing on shots from when lighting images existed
	 * that were taken without the wall connected.
	 */
	wall?: string
	/** Firmware brightness cap (0–1) in force. */
	brightnessCap?: number
}

/** What a shot records about the rig / mill / lighting it was taken with. */
export interface ShotMachineData {
	/** Rig axes (work coords) at capture. */
	rig?: AxesPosition
	/** Mill axes (machine coords) at capture. */
	mill?: AxesPosition
	/** The lighting at capture. §8 */
	led?: ShotLedRecord
	/** previz frame this shot realises (may differ from the timeline frame). */
	previzFrame?: number
	/** The cut that preceded this shot (cuts.ts), when one was run. */
	cut?: {file: string; durationMs: number}
}

//------------------------------------------------------------------------------
// Migration

/**
 * Upgrade a loaded project in place. Idempotent: a file already in the
 * current shape is untouched.
 */
export function migrateAddsubData(
	project: RigAxesHolder & {
		addsub: AddsubProjectData
		komas: ({shots: (ShotMachineData | null | undefined)[]} | null | undefined)[]
		trash?: {shot: ShotMachineData}[]
	},
	opts: {
		/** The file's rig axes are machine coordinates (it has no `rigStorage`). */
		rigInMachine?: boolean
	} = {}
) {
	const a = project.addsub
	// 2026-09-29: the rig's travel was re-measured (X/Z ±550 about the centre,
	// not 0…1200). Projects still carrying the old placeholder defaults get
	// the new ones; anything the user edited is left alone.
	const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y)
	// 2026-10-02: Y reaches −950, not −900. Same rule.
	if (
		same(a.rigLimits, {x: [0, 1200], y: [-900, 0], z: [0, 1200]}) ||
		same(a.rigLimits, {x: [-550, 550], y: [-900, 0], z: [-550, 550]})
	) {
		a.rigLimits = {x: [...RIG_LIMITS.x], y: [...RIG_LIMITS.y], z: [...RIG_LIMITS.z]}
	}
	if (a.calibration && same(a.calibration.rigOffset, [-600, -1300, -600])) {
		a.calibration.rigOffset = [...DEFAULT_CALIBRATION.rigOffset] as typeof a.calibration.rigOffset
	}
	// 2026-10-16: the pupil offset is a vector in camera coordinates; it was
	// the scalar distance d in front of the centre (= (0, 0, −d)).
	const pupil = a.calibration?.pupilOffset as unknown
	if (typeof pupil === 'number') {
		a.calibration.pupilOffset = [0, 0, -pupil]
	}
	// 2026-10-16: the LED placement is hard-coded (led/layout.ts); the
	// per-project layout parameters are gone.
	if (a.led) {
		for (const key of ['layout', 'layoutVersion', 'stripsPerLine', 'topFilmY']) {
			delete (a.led as Record<string, unknown>)[key]
		}
	}
	// 2026-10-16: blocks / film lift, the mill's shoot position and feed, the
	// G54-setting cut and the LED-optional switch are gone (ADDSUB.md
	// 実装メモ「設定の削減」). Film coordinates are world coordinates now.
	const legacy = a as unknown as Record<string, unknown>
	for (const key of [
		'kBase',
		'filmLift',
		'blockHeight',
		'shootPosition',
		'cutPosition',
		'millFeed',
		'ledOptional',
		'cutSetsWorkOffset',
	]) {
		delete legacy[key]
	}
	if (a.calibration) {
		const cal = a.calibration as unknown as Record<string, unknown>
		delete cal.filmOriginWorld
		delete cal.millOffset
	}
	const shots: ShotMachineData[] = []
	for (const koma of project.komas) {
		for (const shot of koma?.shots ?? []) if (shot) shots.push(shot)
	}
	for (const t of project.trash ?? []) shots.push(t.shot)
	for (const shot of shots) {
		const s = shot as unknown as Record<string, unknown>
		delete s.kBase
		delete s.filmLift
	}
	// 2026-10-02: rig axes are stored in work coordinates. work = machine −
	// the work offset, taken from the file's calibration; the controller may
	// know better (rigRebase).
	if (opts.rigInMachine) {
		const {rigOffset, rotaryZero} = a.calibration
		const converted = shiftStoredRigAxes(project, {
			x: -rigOffset[0],
			y: -rigOffset[1],
			z: -rigOffset[2],
			a: -rotaryZero.a,
			b: -rotaryZero.b,
			c: -rotaryZero.c,
		})
		if (converted > 0) a.rigRebase = true
	}
	a.rigStorage = 'work'
}

//------------------------------------------------------------------------------
// Stored rig axes

/** What carries stored rig axes: plans, shot records, the park pose. */
export interface RigAxesHolder {
	addsub: Pick<AddsubProjectData, 'plan' | 'parkPose'>
	komas: (
		| {
				shots: (ShotMachineData | null | undefined)[]
				backupShots?: (ShotMachineData | null | undefined)[]
		  }
		| null
		| undefined
	)[]
	trash?: {shot: ShotMachineData}[]
}

/**
 * Add `delta` (per axis) to every stored set of rig axes, in place: every
 * plan, every shot record (live, backup, trash) and the park pose. Returns
 * how many sets there were.
 */
export function shiftStoredRigAxes(project: RigAxesHolder, delta: AxesPosition): number {
	let count = 0
	const shift = (axes: AxesPosition | null | undefined) => {
		if (!axes) return
		count++
		for (const [axis, d] of Object.entries(delta) as [keyof AxesPosition, number][]) {
			const v = axes[axis]
			// Rounded: the offsets carry float noise, positions have 3 decimals.
			if (v !== undefined && d) axes[axis] = Math.round((v + d) * 1e6) / 1e6
		}
	}
	for (const frames of Object.values(project.addsub.plan ?? {})) {
		for (const plan of Object.values(frames ?? {})) shift(plan?.rig)
	}
	for (const koma of project.komas) {
		for (const shot of koma?.shots ?? []) shift(shot?.rig)
		for (const shot of koma?.backupShots ?? []) shift(shot?.rig)
	}
	for (const t of project.trash ?? []) shift(t.shot.rig)
	shift(project.addsub.parkPose)
	return count
}
