/**
 * Box Rig head kinematics (ADDSUB.md §10).
 *
 * The pan/roll/tilt head hangs upside down from the vertical axis. From the
 * outside in: pan B about world Y, roll C about the optical axis Z, tilt A
 * about X, so the camera rotation is R = Ry(pan) · Rz(roll) · Rx(tilt) —
 * Houdini rotate order "xzy" (first applied first). The camera looks down −Z.
 *
 * The entrance pupil sits at o from the rotation centre in camera
 * coordinates (nominally (0, 0, −d): d in front along the optical axis), so
 * for a desired pupil p and rotation R the head centre is c = p − R·o.
 *
 * All angles in degrees; positions in world mm.
 */

import {mat4, quat, vec3} from 'linearly'

import type {AxesPosition} from '@/utils/fluidnc'

import type {AddsubCalibration} from './config'
import {rigToWorld, worldToRig} from './coords'

export interface CameraPose {
	/** Entrance pupil position. */
	position: vec3
	/** Camera orientation (camera looks down its local −Z). */
	rotation: quat
}

export interface HeadAngles {
	/** Tilt about X (deg). */
	tilt: number
	/** Pan about Y (deg). */
	pan: number
	/** Roll about Z (deg). */
	roll: number
}

const RAD = 180 / Math.PI

function wrap180(deg: number) {
	let d = ((deg + 180) % 360) - 180
	if (d < -180) d += 360
	if (d === -180) d = 180
	return d
}

/** R = Ry(pan) · Rz(roll) · Rx(tilt) */
export function anglesToRotation({tilt, pan, roll}: HeadAngles): quat {
	return quat.mul(
		quat.fromAxisAngle([0, 1, 0], pan),
		quat.fromAxisAngle([0, 0, 1], roll),
		quat.fromAxisAngle([1, 0, 0], tilt)
	)
}

/**
 * Decompose a rotation into pan/roll/tilt in the head's order. Gimbal lock at
 * roll = ±90° (then pan and tilt share an axis; pan is chosen 0).
 */
export function rotationToAngles(r: quat): HeadAngles {
	const m = mat4.fromQuat(r) // column-major: m[col*4 + row]
	const m10 = m[1] // row 1, col 0 = sin(roll)
	const m11 = m[5] // row 1, col 1 = cos(roll)·cos(tilt)
	const m12 = m[9] // row 1, col 2 = −cos(roll)·sin(tilt)
	const m00 = m[0] // row 0, col 0 = cos(pan)·cos(roll)
	const m20 = m[2] // row 2, col 0 = −sin(pan)·cos(roll)

	const sinRoll = Math.max(-1, Math.min(1, m10))
	const roll = Math.asin(sinRoll) * RAD

	if (Math.abs(sinRoll) > 0.999999) {
		// Gimbal lock: R = Ry(pan)·Rz(±90)·Rx(tilt); only pan∓tilt is defined.
		// Fold everything into tilt.
		const m01 = m[4] // row 0, col 1
		const m02 = m[8] // row 0, col 2
		const tilt = Math.atan2(m02 * Math.sign(sinRoll), m01 * Math.sign(sinRoll)) * RAD
		return {tilt: wrap180(tilt), pan: 0, roll}
	}

	return {
		tilt: wrap180(Math.atan2(-m12, m11) * RAD),
		pan: wrap180(Math.atan2(-m20, m00) * RAD),
		roll,
	}
}

/** Head rotation centre for a camera pose (`pupilOffset` = o, camera coords). */
export function rotationCentre(pose: CameraPose, pupilOffset: vec3): vec3 {
	return vec3.sub(pose.position, vec3.transformQuat(pupilOffset, pose.rotation))
}

/** Pupil position for a head centre and rotation (inverse of the above). */
export function pupilFromCentre(centre: vec3, rotation: quat, pupilOffset: vec3): vec3 {
	return vec3.add(centre, vec3.transformQuat(pupilOffset, rotation))
}

/** What the work-coordinate conversions need of the calibration. */
export type WorkKinematics = Pick<AddsubCalibration, 'pupilOffset' | 'rotarySigns'>

/**
 * Rig axes in *work* coordinates → camera pose in *world*. The rig's work
 * origin is the world origin and its rotary work zeros are the head looking
 * straight (stores/rigWork.ts), so only the signs and the pupil offset are
 * involved. Axes left out count as 0.
 */
export function workAxesToCameraPose(axes: AxesPosition, cal: WorkKinematics): CameraPose {
	const rotation = anglesToRotation({
		tilt: (axes.a ?? 0) * cal.rotarySigns.a,
		pan: (axes.b ?? 0) * cal.rotarySigns.b,
		roll: (axes.c ?? 0) * cal.rotarySigns.c,
	})
	const centre: vec3 = [axes.x ?? 0, axes.y ?? 0, axes.z ?? 0]
	return {position: pupilFromCentre(centre, rotation, cal.pupilOffset), rotation}
}

export type RigTarget = Required<Pick<AxesPosition, 'x' | 'y' | 'z' | 'a' | 'b' | 'c'>>

/**
 * Inverse kinematics: a camera pose in *world* coordinates → rig axis values
 * (machine coordinates, absolute).
 */
export function cameraPoseToRigAxes(pose: CameraPose, cal: AddsubCalibration): RigTarget {
	const centre = worldToRig(rotationCentre(pose, cal.pupilOffset), cal.rigOffset)
	const {tilt, pan, roll} = rotationToAngles(pose.rotation)
	return {
		x: centre[0],
		y: centre[1],
		z: centre[2],
		a: tilt * cal.rotarySigns.a + cal.rotaryZero.a,
		b: pan * cal.rotarySigns.b + cal.rotaryZero.b,
		c: roll * cal.rotarySigns.c + cal.rotaryZero.c,
	}
}

/**
 * Forward kinematics: rig axis values (machine coordinates) → camera pose
 * in *world* coordinates. Missing axes are treated as 0.
 */
export function rigAxesToCameraPose(axes: AxesPosition, cal: AddsubCalibration): CameraPose {
	const rotation = anglesToRotation({
		tilt: ((axes.a ?? 0) - cal.rotaryZero.a) * cal.rotarySigns.a,
		pan: ((axes.b ?? 0) - cal.rotaryZero.b) * cal.rotarySigns.b,
		roll: ((axes.c ?? 0) - cal.rotaryZero.c) * cal.rotarySigns.c,
	})
	const centreWorld = rigToWorld(
		[axes.x ?? 0, axes.y ?? 0, axes.z ?? 0],
		cal.rigOffset
	)
	return {position: pupilFromCentre(centreWorld, rotation, cal.pupilOffset), rotation}
}

export interface RotationDelta {
	/** About world Y (deg) — the head's pan, so it stays level whatever the tilt. */
	pan?: number
	/** About the camera's own X (deg). */
	tilt?: number
	/** About the camera's own Z, the optical axis (deg). */
	roll?: number
}

/**
 * Rotate a pose about its entrance pupil: the picture swings without
 * parallax and the pupil stays where it is. Pan is about world Y (like the
 * head's B), tilt and roll about the camera's own X and Z. (§11.2)
 */
export function orbitAboutPupil(pose: CameraPose, delta: RotationDelta): CameraPose {
	const q = quat.mul(
		quat.fromAxisAngle([0, 1, 0], delta.pan ?? 0),
		pose.rotation,
		quat.fromAxisAngle([1, 0, 0], delta.tilt ?? 0),
		quat.fromAxisAngle([0, 0, 1], delta.roll ?? 0)
	)
	return {position: pose.position, rotation: quat.normalize(q)}
}

/**
 * The rig axes (machine coordinates) that turn the camera by `delta` about
 * its entrance pupil from where it is: X/Y/Z move so the pupil stays put
 * while A/B/C turn. The rotaries take the short way from their current
 * angle (no unwinding through ±180°). One `$J=`/G53 line with all six axes
 * ends there; the path between is a chord, which is fine for a stop-motion
 * move that settles before the shot.
 */
export function rotateAboutPupil(
	axes: AxesPosition,
	delta: RotationDelta,
	cal: AddsubCalibration
): RigTarget {
	const pose = rigAxesToCameraPose(axes, cal)
	const target = cameraPoseToRigAxes(orbitAboutPupil(pose, delta), cal)
	const near = (now: number | undefined, v: number) =>
		now === undefined ? v : now + wrap180(v - now)
	return {
		x: target.x,
		y: target.y,
		z: target.z,
		a: near(axes.a, target.a),
		b: near(axes.b, target.b),
		c: near(axes.c, target.c),
	}
}

/**
 * Aim the camera at a point: the tilt (A) and pan (B) that put `target`
 * (world = the rig's work coordinates, mm) on the optical axis from where the
 * head is, with roll (C) left as it is. The pupil sits on that axis, so
 * aiming the rotation centre aims the lens. Pan takes the shorter way round
 * from where it is, and stays put for a target straight above / below.
 * Returns machine coordinates; null when the target is at the rotation
 * centre or can't be met at this roll (too steep for the rolled tilt axis).
 */
export function aimRigAxes(
	axes: AxesPosition,
	target: vec3,
	cal: AddsubCalibration
): Required<Pick<AxesPosition, 'a' | 'b'>> | null {
	const centre = rigToWorld([axes.x ?? 0, axes.y ?? 0, axes.z ?? 0], cal.rigOffset)
	const to = vec3.sub(target, centre)
	const distance = vec3.length(to)
	if (distance < 1e-6) return null
	const [dx, dy, dz] = vec3.scale(to, 1 / distance)

	// The optical axis is R·(0, 0, −1) with R = Ry(pan)·Rz(roll)·Rx(tilt):
	// its height is cos(roll)·sin(tilt), and pan turns the rest about Y.
	const roll = (((axes.c ?? 0) - cal.rotaryZero.c) * cal.rotarySigns.c) / RAD
	const sinTilt = dy / Math.cos(roll)
	if (!Number.isFinite(sinTilt) || Math.abs(sinTilt) > 1) return null
	const tilt = Math.asin(sinTilt)

	const panNow = ((axes.b ?? 0) - cal.rotaryZero.b) * cal.rotarySigns.b
	let pan = panNow
	if (Math.hypot(dx, dz) > 1e-9) {
		// The axis before panning, Rz(roll)·Rx(tilt)·(0, 0, −1), seen from above.
		const vx = -Math.sin(roll) * Math.sin(tilt)
		const vz = -Math.cos(tilt)
		pan = panNow + wrap180((Math.atan2(dx, dz) - Math.atan2(vx, vz)) * RAD - panNow)
	}

	return {
		a: tilt * RAD * cal.rotarySigns.a + cal.rotaryZero.a,
		b: pan * cal.rotarySigns.b + cal.rotaryZero.b,
	}
}

/**
 * Orbit the head about the vertical axis through world X = Z = 0 by `deg`:
 * the rotation centre swings round that axis and pan turns by the same
 * angle, so the whole camera pose is rotated about it — what it looks at on
 * the axis stays where it is in the picture. Tilt, roll and height are
 * untouched. Returns the axes that change (machine coordinates).
 */
export function orbitRigAxes(
	axes: AxesPosition,
	deg: number,
	cal: AddsubCalibration
): Required<Pick<AxesPosition, 'x' | 'z' | 'b'>> {
	const centre = rigToWorld([axes.x ?? 0, axes.y ?? 0, axes.z ?? 0], cal.rigOffset)
	const turned = vec3.transformQuat(centre, quat.fromAxisAngle([0, 1, 0], deg))
	const rig = worldToRig(turned, cal.rigOffset)
	return {
		x: rig[0],
		z: rig[2],
		b: (axes.b ?? 0) + deg * cal.rotarySigns.b,
	}
}
