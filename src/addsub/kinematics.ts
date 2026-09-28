/**
 * Box Rig head kinematics (ADDSUB.md §10).
 *
 * The pan/roll/tilt head hangs upside down from the vertical axis. From the
 * outside in: pan B about world Y, roll C about the optical axis Z, tilt A
 * about X, so the camera rotation is R = Ry(pan) · Rz(roll) · Rx(tilt) —
 * Houdini rotate order "xzy" (first applied first). The camera looks down −Z.
 *
 * The entrance pupil sits d in front of the rotation centre along the optical
 * axis: o = (0, 0, −d) in camera coordinates, so for a desired pupil p and
 * rotation R the head centre is c = p − R·o.
 *
 * All angles in degrees; positions in world mm.
 */

import {mat4, quat, vec3} from 'linearly'

import type {AxesPosition} from '@/utils/fluidnc'

import type {AddsubCalibration} from './config'
import {filmToWorld, rigToWorld,worldToFilm, worldToRig} from './coords'

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

/** Head rotation centre for a camera pose. */
export function rotationCentre(pose: CameraPose, pupilOffset: number): vec3 {
	const o: vec3 = [0, 0, -pupilOffset]
	return vec3.sub(pose.position, vec3.transformQuat(o, pose.rotation))
}

/** Pupil position for a head centre and rotation (inverse of the above). */
export function pupilFromCentre(centre: vec3, rotation: quat, pupilOffset: number): vec3 {
	const o: vec3 = [0, 0, -pupilOffset]
	return vec3.add(centre, vec3.transformQuat(o, rotation))
}

export type RigTarget = Required<Pick<AxesPosition, 'x' | 'y' | 'z' | 'a' | 'b' | 'c'>>

/**
 * Inverse kinematics: a camera pose in *film* coordinates → rig axis values
 * (machine coordinates, absolute).
 */
export function cameraPoseToRigAxes(
	pose: CameraPose,
	lift: number,
	cal: AddsubCalibration
): RigTarget {
	const worldPose: CameraPose = {
		position: filmToWorld(pose.position, lift, cal.filmOriginWorld),
		rotation: pose.rotation,
	}
	const centre = worldToRig(rotationCentre(worldPose, cal.pupilOffset), cal.rigOffset)
	const {tilt, pan, roll} = rotationToAngles(pose.rotation)
	return {
		x: centre[0],
		y: centre[1],
		z: centre[2],
		a: tilt * cal.rotarySigns.a,
		b: pan * cal.rotarySigns.b,
		c: roll * cal.rotarySigns.c,
	}
}

/**
 * Forward kinematics: rig axis values → camera pose in *film* coordinates.
 * Missing axes are treated as 0.
 */
export function rigAxesToCameraPose(
	axes: AxesPosition,
	lift: number,
	cal: AddsubCalibration
): CameraPose {
	const rotation = anglesToRotation({
		tilt: (axes.a ?? 0) * cal.rotarySigns.a,
		pan: (axes.b ?? 0) * cal.rotarySigns.b,
		roll: (axes.c ?? 0) * cal.rotarySigns.c,
	})
	const centreWorld = rigToWorld(
		[axes.x ?? 0, axes.y ?? 0, axes.z ?? 0],
		cal.rigOffset
	)
	const pupilWorld = pupilFromCentre(centreWorld, rotation, cal.pupilOffset)
	return {
		position: worldToFilm(pupilWorld, lift, cal.filmOriginWorld),
		rotation,
	}
}

/**
 * Rotate the current pose by a delta expressed in the *view* frame (screen
 * pan / tilt / roll) about the entrance pupil, so the picture swings without
 * parallax; returns the new pose. (§11.2)
 */
export function orbitAboutPupil(
	pose: CameraPose,
	delta: {pan?: number; tilt?: number; roll?: number}
): CameraPose {
	// Screen-relative axes: pan about the camera's local Y, tilt about local X,
	// roll about local Z. Applied intrinsically.
	const q = quat.mul(
		pose.rotation,
		quat.fromAxisAngle([0, 1, 0], delta.pan ?? 0),
		quat.fromAxisAngle([1, 0, 0], delta.tilt ?? 0),
		quat.fromAxisAngle([0, 0, 1], delta.roll ?? 0)
	)
	return {position: pose.position, rotation: quat.normalize(q)}
}
