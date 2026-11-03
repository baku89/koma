/**
 * Distortion calibration of the Box Rig (ADDSUB.md 実装メモ「Box Rig の 4 点
 * 歪み補正と Calibrated 座標系」).
 *
 * The rig's work coordinates say where the controller *thinks* the camera is;
 * the gantry sags, the hanging column twists, the pan axis doesn't quite go
 * through the point the kinematics assume, so the camera is really somewhere
 * a little different, and differently in different poses. This module models
 * that as a smooth *pose* error of the head's mount, fitted from poses the
 * operator trued up by eye:
 *
 *   - koma sends the rig to a nominal pose (the pupil `radius` mm from the
 *     `base` point along one of the DISTORTION_DIRECTIONS, looking at the
 *     base — the calibration *points* are the chosen directions × radii),
 *   - the operator jogs until the marker at the base looks right in the
 *     preview and records the pose,
 *   - every sample gives the error at that pose: a translation of the head
 *     centre (world mm) and a rotation of the mount (world frame, as a
 *     rotation vector in degrees). Both are fitted as affine functions of
 *     the head's *position* (4 unknowns per component) plus, when the
 *     samples can tell it apart, a cos / sin of the *pan* angle (6
 *     unknowns): an off-centre or tilted pan axis moves and turns the camera
 *     by an amount that depends on the pan, not on where the head is. At a
 *     single radius the two are indistinguishable (the pan is a function of
 *     the direction, and so is the position), which is why a second radius
 *     is what separates them; the fit falls back to the affine-only model
 *     when it can't. Fewer points than unknowns give the minimum-norm fit
 *     (one point = a constant offset), more average out.
 *
 * The rotation error is kept as a world-frame rotation applied *before* the
 * head's own angles (δR · Ry(pan)·Rz(roll)·Rx(tilt)), not as per-axis angle
 * deltas: a twist of the column is the same twist whichever way the head is
 * panned, and at the top point (looking straight down) pan and roll both turn
 * the picture, so per-axis deltas there would depend on which ring the
 * operator happened to use.
 *
 * Three frames, then (stores/rigWork.ts):
 *   Machine     the controller's MPos
 *   Work        MPos − WCO: what the controller calls the pose
 *   Calibrated  where the camera really is — plans, previz, Houdini, the 3D
 *               view and the LED wall all live here. calibratedToWork() is
 *               applied just before a move is sent; workToCalibrated() reads
 *               the controller's position back into it.
 *
 * All positions in mm, angles in degrees. Pure functions, no store access.
 */

import {quat, vec3} from 'linearly'

import type {AxesPosition} from '@/utils/fluidnc'

import {
	anglesToRotation,
	type RigTarget,
	rotationCentre,
	rotationToAngles,
	type WorkKinematics,
} from './kinematics'

export type RigAxes = RigTarget

export interface DistortionDirection {
	id: string
	label: string
	/** One or two letters for a toggle / a point's row. */
	short: string
	/** Unit direction from the base point to the pupil. */
	dir: vec3
}

const unit = (v: vec3): vec3 => vec3.normalize(v)

/** Directions a calibration point can look at the base from. */
export const DISTORTION_DIRECTIONS: readonly DistortionDirection[] = [
	{id: 'front', label: 'Front (+Z)', short: 'F', dir: [0, 0, 1]},
	{id: 'top', label: 'Top (+Y)', short: 'T', dir: [0, 1, 0]},
	{id: 'right', label: 'Right (+X)', short: 'R', dir: [1, 0, 0]},
	{id: 'left', label: 'Left (−X)', short: 'L', dir: [-1, 0, 0]},
	{id: 'back', label: 'Back (−Z)', short: 'B', dir: [0, 0, -1]},
	{id: 'frontRight', label: 'Front-right (pan 45°)', short: 'FR', dir: unit([1, 0, 1])},
	{id: 'frontLeft', label: 'Front-left (pan −45°)', short: 'FL', dir: unit([-1, 0, 1])},
	{id: 'backRight', label: 'Back-right (pan 135°)', short: 'BR', dir: unit([1, 0, -1])},
	{id: 'backLeft', label: 'Back-left (pan −135°)', short: 'BL', dir: unit([-1, 0, -1])},
	{id: 'frontHigh', label: 'Front, 45° up', short: 'F↑', dir: unit([0, 1, 1])},
	{id: 'rightHigh', label: 'Right, 45° up', short: 'R↑', dir: unit([1, 1, 0])},
	{id: 'leftHigh', label: 'Left, 45° up', short: 'L↑', dir: unit([-1, 1, 0])},
]

/**
 * A calibration pose: the pupil `radius` mm from the base along `dir`,
 * looking at it — with the head rolled by `roll`, or, looking straight down
 * (where the pan only turns the picture), panned by `pan`.
 */
export interface DistortionPoint {
	/** `<direction>@<radius>[/b<pan>|/c<roll>]` — the key of its sample. */
	id: string
	label: string
	direction: DistortionDirection
	dir: vec3
	radius: number
	/** Pan override (degrees), only for the straight-down direction; null = the direction's own. */
	pan: number | null
	/** Roll (degrees). */
	roll: number
}

/** Looking straight up or down: the pan is free (it turns the picture). */
export const isVertical = (dir: vec3) => Math.hypot(dir[0], dir[2]) < 1e-9

/**
 * Whether the head can look along −`dir` with that roll: the roll sits
 * between pan and tilt, so the height the tilt can give is scaled by cos
 * roll (|sin tilt| ≤ |cos roll|). Level directions take any roll; 45° up
 * takes |roll| ≤ 45°.
 */
export const rollReaches = (dir: vec3, rollDeg: number) =>
	Math.abs(dir[1]) <= Math.abs(Math.cos((rollDeg * Math.PI) / 180)) + 1e-9

export function pointId(direction: string, radius: number, variant: {pan?: number | null; roll?: number} = {}) {
	const base = `${direction}@${radius}`
	if (variant.pan) return `${base}/b${variant.pan}`
	if (variant.roll) return `${base}/c${variant.roll}`
	return base
}

/**
 * The points a calibration asks for: every chosen direction at every
 * radius; the vertical ones once per `topPans`, the others once per `rolls`.
 */
export function distortionPoints(
	d: Pick<RigDistortion, 'radii' | 'directions' | 'topPans' | 'rolls'>
): DistortionPoint[] {
	const out: DistortionPoint[] = []
	for (const radius of d.radii) {
		for (const direction of DISTORTION_DIRECTIONS) {
			if (!d.directions.includes(direction.id)) continue
			const vertical = isVertical(direction.dir)
			const variants = vertical
				? (d.topPans.length ? d.topPans : [0]).map(pan => ({pan, roll: 0}))
				: (d.rolls.length ? d.rolls : [0])
						.filter(roll => rollReaches(direction.dir, roll))
						.map(roll => ({pan: null, roll}))
			for (const v of variants) {
				const tag = v.pan ? ` · B ${v.pan}°` : v.roll ? ` · C ${v.roll}°` : ''
				out.push({
					id: pointId(direction.id, radius, v),
					label: `${direction.label} · ${radius} mm${tag}`,
					direction,
					dir: direction.dir,
					radius,
					pan: v.pan,
					roll: v.roll,
				})
			}
		}
	}
	return out
}

export interface DistortionSample {
	/** The pose the rig was sent to: the ideal (calibrated) work axes. */
	nominal: RigAxes
	/**
	 * Where the operator put the rig for the marker to look right, in work
	 * axes as the controller reports them.
	 */
	actual: RigAxes
	at: number
}

export interface RigDistortion {
	/** Apply the correction (off = Calibrated ≡ Work, samples kept). */
	enabled: boolean
	/** The marker, work mm. */
	base: vec3
	/**
	 * Pupil-to-base distances of the calibration poses, mm. Two of them let
	 * the fit tell a pan-dependent error from a position-dependent one.
	 */
	radii: number[]
	/** DISTORTION_DIRECTIONS ids in use. */
	directions: string[]
	/**
	 * Pans (degrees) to calibrate the straight-down direction at: it looks at
	 * the base whatever the pan, so these tell a pan-axis error from a
	 * position error without a second radius.
	 */
	topPans: number[]
	/** Rolls (degrees) to calibrate every other direction at (a roll-axis error turns with them). */
	rolls: number[]
	/**
	 * Side of the marker's face, mm, for the preview reticle (the square the
	 * face should fill when the pose is right).
	 */
	markerSize: number
	/** By point id (`<direction>@<radius>`). */
	samples: Partial<Record<string, DistortionSample>>
}

export const DEFAULT_RIG_DISTORTION: RigDistortion = {
	enabled: true,
	base: [0, 120, 0],
	radii: [400],
	directions: ['front', 'top', 'right', 'left'],
	topPans: [0],
	rolls: [0],
	markerSize: 60,
	samples: {},
}

const RAD = Math.PI / 180

/** Positions are reported to 3 decimals; angles too. (−0 → 0.) */
const round3 = (v: number) => Math.round(v * 1000) / 1000 || 0

function wrap180(deg: number) {
	let d = ((deg + 180) % 360) - 180
	if (d < -180) d += 360
	if (d === -180) d = 180
	return d
}

/** `v` as the angle equivalent to it nearest `to` (no unwinding past ±180). */
function near(to: number, v: number) {
	return to + wrap180(v - to)
}

//------------------------------------------------------------------------------
// Poses from axes

interface HeadPose {
	/** Rotation centre of the head, world mm. */
	centre: vec3
	/** Camera rotation (looks down its −Z). */
	rotation: quat
}

/** Work axes → head pose (world). The work origin is the world origin. */
export function headPose(axes: RigAxes, cal: WorkKinematics): HeadPose {
	return {
		centre: [axes.x, axes.y, axes.z],
		rotation: anglesToRotation({
			tilt: axes.a * cal.rotarySigns.a,
			pan: axes.b * cal.rotarySigns.b,
			roll: axes.c * cal.rotarySigns.c,
		}),
	}
}

/**
 * Head pose → work axes. The rotaries take the value nearest `like`'s (a
 * pan of 370° stays 370°, not 10°) when given.
 */
export function axesFromHeadPose(pose: HeadPose, cal: WorkKinematics, like?: RigAxes): RigAxes {
	// At roll ±90 (gimbal lock) the pan is whatever we say: keep the current one.
	const {tilt, pan, roll} = rotationToAngles(pose.rotation, like ? like.b * cal.rotarySigns.b : 0)
	let a = tilt * cal.rotarySigns.a
	let b = pan * cal.rotarySigns.b
	let c = roll * cal.rotarySigns.c
	if (like) {
		a = near(like.a, a)
		b = near(like.b, b)
		c = near(like.c, c)
	}
	return {
		x: round3(pose.centre[0]),
		y: round3(pose.centre[1]),
		z: round3(pose.centre[2]),
		a: round3(a),
		b: round3(b),
		c: round3(c),
	}
}

/**
 * The nominal pose for a calibration point: the entrance pupil `point.radius`
 * mm from the base along `point.dir`, the optical axis through the base, the
 * point's roll (and, straight down, its pan).
 * Work axes (= calibrated frame).
 */
export function nominalAxes(
	point: DistortionPoint,
	d: Pick<RigDistortion, 'base'>,
	cal: WorkKinematics
): RigAxes {
	const pupil = vec3.add(d.base, vec3.scale(vec3.normalize(point.dir), point.radius))
	const [fx, fy, fz] = vec3.normalize(vec3.sub(d.base, pupil))
	const roll = point.roll
	// The optical axis is R·(0, 0, −1) with R = Ry(pan)·Rz(roll)·Rx(tilt)
	// (kinematics.ts): Rx(tilt) turns it to (0, sin t, −cos t), Rz(roll) to
	// (−sin r·sin t, cos r·sin t, −cos t), Ry(pan) spins that about Y. The
	// roll sits *between* pan and tilt, so with a roll the tilt that gives
	// the height is sin t = f_y / cos r, and the pan turns the horizontal
	// remainder onto the target. (|f_y| > |cos r| is unreachable —
	// distortionPoints leaves those out; here it is clamped.)
	const cr = Math.cos(roll * RAD)
	const sr = Math.sin(roll * RAD)
	const sinT = Math.abs(cr) < 1e-9 ? 0 : Math.max(-1, Math.min(1, fy / cr))
	const tilt = Math.asin(sinT) / RAD
	const cosT = Math.cos(tilt * RAD)
	const h: [number, number] = [-sr * sinT, -cosT] // the axis's (x, z) before the pan
	const pan =
		Math.hypot(fx, fz) < 1e-9 || Math.hypot(h[0], h[1]) < 1e-9
			? (point.pan ?? 0)
			: wrap180((Math.atan2(fx, fz) - Math.atan2(h[0], h[1])) / RAD)
	const rotation = anglesToRotation({tilt, pan, roll})
	const centre = rotationCentre({position: pupil, rotation}, cal.pupilOffset)
	// The angles go in as chosen, not decomposed back out of the rotation: at
	// roll ±90 the gimbal is locked (pan and tilt share an axis) and the
	// decomposition could hand back any split of the two.
	return {
		x: round3(centre[0]),
		y: round3(centre[1]),
		z: round3(centre[2]),
		a: round3(tilt * cal.rotarySigns.a),
		b: round3(pan * cal.rotarySigns.b),
		c: round3(roll * cal.rotarySigns.c),
	}
}

//------------------------------------------------------------------------------
// Rotation vectors (world frame, degrees)

/** q → axis·angle, the angle in (−180, 180]. */
function toRotationVector(q: quat): vec3 {
	const {axis, deg} = quat.axisAngle(quat.normalize(q))
	const angle = wrap180(deg)
	if (!Number.isFinite(angle) || Math.abs(angle) < 1e-12) return [0, 0, 0]
	return vec3.scale(axis, angle)
}

function fromRotationVector(v: vec3): quat {
	const angle = vec3.length(v)
	if (angle < 1e-12) return quat.identity
	return quat.fromAxisAngle(vec3.scale(v, 1 / angle), angle)
}

//------------------------------------------------------------------------------
// The field

/** The pan / roll of a pose, degrees (the head angles the harmonics are taken of). */
function panOf(axes: RigAxes, cal: WorkKinematics) {
	return axes.b * cal.rotarySigns.b
}
function rollOf(axes: RigAxes, cal: WorkKinematics) {
	return axes.c * cal.rotarySigns.c
}

/** Which harmonic groups are in a fit. */
export interface FieldTerms {
	/** cos pan, sin pan: an off-centre / tilted pan axis. */
	pan: boolean
	/**
	 * (cos roll − 1), sin roll, and each times cos pan and sin pan: a roll
	 * axis off the pupil swings the camera by Ry(pan)·(Rz(roll) − I)·e, whose
	 * vertical part is a function of the roll alone and whose horizontal part
	 * turns with the pan. Zero at roll 0.
	 */
	roll: boolean
}

/** Number of unknowns per component for a set of terms. */
export function fieldUnknowns(t: FieldTerms) {
	return 4 + (t.pan ? 2 : 0) + (t.roll ? 6 : 0)
}

/**
 * Design row of a sample: position (normalised, about the centroid), 1, and
 * the harmonics of the groups in use.
 */
function features(q: vec3, panDeg: number, rollDeg: number, t: FieldTerms): number[] {
	const row = [q[0], q[1], q[2], 1]
	const cp = Math.cos(panDeg * RAD)
	const sp = Math.sin(panDeg * RAD)
	if (t.pan) row.push(cp, sp)
	if (t.roll) {
		const cr = Math.cos(rollDeg * RAD) - 1
		const sr = Math.sin(rollDeg * RAD)
		row.push(cr, sr, cr * cp, cr * sp, sr * cp, sr * sp)
	}
	return row
}

/** A row padded to the full 12 columns (zeros for the groups not in use). */
function padRow(w: number[], t: FieldTerms): number[] {
	const out = [w[0], w[1], w[2], w[3]]
	let i = 4
	out.push(...(t.pan ? [w[i++], w[i++]] : [0, 0]))
	out.push(...(t.roll ? [w[i++], w[i++], w[i++], w[i++], w[i++], w[i++]] : [0, 0, 0, 0, 0, 0]))
	return out
}

export interface DistortionField {
	/** Mean nominal head position of the samples (the fit's origin). */
	centroid: vec3
	/**
	 * Six rows — translation x, y, z (mm), rotation vector x, y, z (deg) —
	 * each [∂/∂x, ∂/∂y, ∂/∂z, value at the centroid, ·cos pan, ·sin pan,
	 * ·(cos roll − 1), ·sin roll, ·(cos roll − 1)cos pan, ·(cos roll − 1)sin pan,
	 * ·sin roll cos pan, ·sin roll sin pan] (a group's columns are 0 when it
	 * is not in `terms`).
	 */
	rows: number[][]
	/** The harmonic groups in the fit (those the samples could separate from the rest). */
	terms: FieldTerms
	/** Unknowns per component: 4, +2 with the pan terms, +6 with the roll terms. */
	unknowns: number
	count: number
	/** Largest misfit over the samples (mm / deg); 0 with no more points than unknowns. */
	residual: {linear: number; rotary: number}
}

export interface DistortionDelta {
	/** Head centre error, world mm. */
	translation: vec3
	/** Mount rotation error, world frame, degrees (rotation vector). */
	rotation: vec3
}

/** The error of a sample: actual pose relative to the nominal one. */
export function sampleDelta(s: DistortionSample, cal: WorkKinematics): DistortionDelta {
	const n = headPose(s.nominal, cal)
	const a = headPose(s.actual, cal)
	return {
		translation: vec3.sub(a.centre, n.centre),
		// R_actual = δR · R_nominal
		rotation: toRotationVector(quat.mul(a.rotation, quat.invert(n.rotation))),
	}
}

/**
 * Solve the small symmetric system (M + λI) w = b by Gaussian elimination.
 * λ makes a rank-deficient fit (fewer points than unknowns) return the
 * minimum-norm answer instead of blowing up.
 */
function solveLinear(M: number[][], b: number[], lambda: number): number[] {
	const n = b.length
	const A = M.map((row, i) => [...row.map((v, j) => v + (i === j ? lambda : 0)), b[i]])
	for (let col = 0; col < n; col++) {
		let pivot = col
		for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r
		;[A[col], A[pivot]] = [A[pivot], A[col]]
		const p = A[col][col]
		if (Math.abs(p) < 1e-300) continue
		for (let r = 0; r < n; r++) {
			if (r === col) continue
			const f = A[r][col] / p
			if (f === 0) continue
			for (let k = col; k <= n; k++) A[r][k] -= f * A[col][k]
		}
	}
	return A.map((row, i) => (Math.abs(row[i]) < 1e-300 ? 0 : row[n] / row[i]))
}

/** Least squares of `targets` on `design` (ridge λ), one weight vector per target. */
function fit(design: number[][], targets: number[][], lambda: number): number[][] {
	const k = design[0].length
	const M = Array.from({length: k}, (_, i) =>
		Array.from({length: k}, (_, j) => design.reduce((sum, row) => sum + row[i] * row[j], 0))
	)
	return targets.map(t => {
		const b = Array.from({length: k}, (_, i) => design.reduce((sum, row, s) => sum + row[i] * t[s], 0))
		return solveLinear(M, b, lambda)
	})
}

/**
 * Whether a group of harmonic columns can be told from the columns already
 * in the design: enough samples for the unknowns, and none of the new
 * columns (nearly) a linear function of the old ones over the samples. At
 * one radius with roll 0 everywhere, cos / sin of the pan are exactly affine
 * in the position (both follow the direction), so the fit would split the
 * error arbitrarily between the two; a second radius, or the straight-down
 * point at other pans, breaks that. The roll group needs rolled points.
 */
const SEPARATION = 0.1

function separable(design: number[][], columns: number[][]): boolean {
	if (design.length < design[0].length + columns.length) return false
	const w = fit(design, columns, 1e-9)
	return columns.every((h, c) => {
		const rms = Math.sqrt(
			design.reduce((sum, row, i) => {
				const r = h[i] - row.reduce((acc, v, j) => acc + v * w[c][j], 0)
				return sum + r * r
			}, 0) / design.length
		)
		return rms > SEPARATION
	})
}

/** The harmonic groups the samples can support, pan first. */
function chooseTerms(normalised: vec3[], pans: number[], rolls: number[]): FieldTerms {
	const terms: FieldTerms = {pan: false, roll: false}
	const design = () => normalised.map((q, i) => features(q, pans[i], rolls[i], terms))
	const columnsOf = (t: FieldTerms) => {
		const full = normalised.map((q, i) => features(q, pans[i], rolls[i], t))
		const from = design()[0].length
		return Array.from({length: full[0].length - from}, (_, k) => full.map(row => row[from + k]))
	}
	if (separable(design(), columnsOf({pan: true, roll: false}))) terms.pan = true
	if (separable(design(), columnsOf({...terms, roll: true}))) terms.roll = true
	return terms
}

/**
 * Fit the error field to the samples. Null without samples.
 */
export function solveDistortion(
	samples: readonly DistortionSample[],
	cal: WorkKinematics
): DistortionField | null {
	if (samples.length === 0) return null
	const positions = samples.map(s => headPose(s.nominal, cal).centre)
	const pans = samples.map(s => panOf(s.nominal, cal))
	const rolls = samples.map(s => rollOf(s.nominal, cal))
	const centroid = vec3.average(...positions)
	// Positions normalised to ~1 so one λ suits every radius.
	const scale = Math.max(1e-9, ...positions.map(p => vec3.length(vec3.sub(p, centroid))))
	const normalised = positions.map(p => vec3.scale(vec3.sub(p, centroid), 1 / scale))
	const terms = chooseTerms(normalised, pans, rolls)
	const design = normalised.map((q, i) => features(q, pans[i], rolls[i], terms))
	const deltas = samples.map(s => sampleDelta(s, cal))
	const targets = [
		...([0, 1, 2] as const).map(i => deltas.map(d => d.translation[i])),
		...([0, 1, 2] as const).map(i => deltas.map(d => d.rotation[i])),
	]
	const rows = fit(design, targets, 1e-9).map(w => {
		const row = padRow(w, terms)
		row[0] /= scale
		row[1] /= scale
		row[2] /= scale
		return row
	})
	const field: DistortionField = {
		centroid,
		rows,
		terms,
		unknowns: fieldUnknowns(terms),
		count: samples.length,
		residual: {linear: 0, rotary: 0},
	}
	for (let i = 0; i < samples.length; i++) {
		const at = deltaAt(field, positions[i], pans[i], rolls[i])
		field.residual.linear = Math.max(
			field.residual.linear,
			vec3.length(vec3.sub(at.translation, deltas[i].translation))
		)
		field.residual.rotary = Math.max(
			field.residual.rotary,
			vec3.length(vec3.sub(at.rotation, deltas[i].rotation))
		)
	}
	return field
}

/** The error the field predicts at a head position, pan and roll (calibrated frame). */
export function deltaAt(field: DistortionField, position: vec3, panDeg: number, rollDeg: number): DistortionDelta {
	const q = vec3.sub(position, field.centroid)
	const f = features(q, panDeg, rollDeg, {pan: true, roll: true})
	const at = (row: number[]) => row.reduce((sum, w, i) => sum + w * f[i], 0)
	return {
		translation: [at(field.rows[0]), at(field.rows[1]), at(field.rows[2])],
		rotation: [at(field.rows[3]), at(field.rows[4]), at(field.rows[5])],
	}
}

/**
 * Calibrated → work: the axes to send so the camera ends up at the ideal pose
 * `axes` describes. Identity without a field.
 */
export function calibratedToWork(
	axes: RigAxes,
	field: DistortionField | null,
	cal: WorkKinematics
): RigAxes {
	if (!field) return axes
	const pose = headPose(axes, cal)
	const d = deltaAt(field, pose.centre, panOf(axes, cal), rollOf(axes, cal))
	return axesFromHeadPose(
		{
			centre: vec3.add(pose.centre, d.translation),
			rotation: quat.normalize(quat.mul(fromRotationVector(d.rotation), pose.rotation)),
		},
		cal,
		axes
	)
}

/**
 * Work → calibrated: where the camera really is for the axes the controller
 * reports. The inverse of calibratedToWork: the translation part is affine
 * in the calibrated position (a 3×3 solve) given the calibrated pan and
 * roll, which in turn follow from the rotation part — a few fixed-point
 * rounds settle both (the corrections are small).
 */
export function workToCalibrated(
	axes: RigAxes,
	field: DistortionField | null,
	cal: WorkKinematics
): RigAxes {
	if (!field) return axes
	const pose = headPose(axes, cal)
	const M = field.rows.slice(0, 3)
	const IM = M.map((row, i) => [row[0] + (i === 0 ? 1 : 0), row[1] + (i === 1 ? 1 : 0), row[2] + (i === 2 ? 1 : 0)])
	let pan = panOf(axes, cal)
	let roll = rollOf(axes, cal)
	let c: vec3 = pose.centre
	let rotation = pose.rotation
	const rounds = field.terms.pan || field.terms.roll ? 4 : 1
	for (let round = 0; round < rounds; round++) {
		// The part of the translation that doesn't depend on the position.
		const d0 = deltaAt(field, field.centroid, pan, roll).translation
		// c + M(c − centroid) + d0 = actual  ⇒  (I + M) c = actual − d0 + M·centroid
		const rhs = [0, 1, 2].map(
			i =>
				pose.centre[i] -
				d0[i] +
				M[i][0] * field.centroid[0] +
				M[i][1] * field.centroid[1] +
				M[i][2] * field.centroid[2]
		)
		c = solveLinear(IM, rhs, 0) as unknown as vec3
		const d = deltaAt(field, c, pan, roll)
		rotation = quat.normalize(quat.mul(quat.invert(fromRotationVector(d.rotation)), pose.rotation))
		const angles = rotationToAngles(rotation, pan)
		pan = angles.pan
		roll = angles.roll
	}
	return axesFromHeadPose({centre: c, rotation}, cal, axes)
}

/** Every axis of a (possibly partial) set, the missing ones from `fill`. */
export function completeAxes(axes: AxesPosition, fill: RigAxes): RigAxes {
	return {
		x: axes.x ?? fill.x,
		y: axes.y ?? fill.y,
		z: axes.z ?? fill.z,
		a: axes.a ?? fill.a,
		b: axes.b ?? fill.b,
		c: axes.c ?? fill.c,
	}
}

export const ZERO_AXES: RigAxes = {x: 0, y: 0, z: 0, a: 0, b: 0, c: 0}

/** Axis-by-axis difference actual − nominal, for showing a sample. */
export function axisDeltas(s: DistortionSample): RigAxes {
	return {
		x: round3(s.actual.x - s.nominal.x),
		y: round3(s.actual.y - s.nominal.y),
		z: round3(s.actual.z - s.nominal.z),
		a: round3(wrap180(s.actual.a - s.nominal.a)),
		b: round3(wrap180(s.actual.b - s.nominal.b)),
		c: round3(wrap180(s.actual.c - s.nominal.c)),
	}
}

/**
 * Half-width of the reticle square as a fraction of the picture width: a
 * face `markerSize` wide seen square-on from `radius` (pupil distance)
 * through a pinhole of focal `focal` on a sensor `sensorWidth` wide.
 */
export function reticleHalfWidth(markerSize: number, radius: number, focal: number, sensorWidth: number) {
	if (radius <= 0 || sensorWidth <= 0) return 0
	return (focal * markerSize) / (radius * sensorWidth) / 2
}
