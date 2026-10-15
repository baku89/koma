/**
 * A camera pose as Houdini sends it (scripts/houdini/koma_bridge.py):
 *
 *   {position: [x, y, z], rotation: [x, y, z, w] | angles: {tilt, pan, roll},
 *    frame?: 'world' | 'rig' | 'film', unit?: 'mm' | 'm'}
 *
 * turned into koma's world pose (mm + quaternion). 'film' is the old name of
 * the world frame; 'rig' is the rig's machine frame (converted with the
 * calibration's rig offset). Used by the live `rig:pose` topic and by the
 * inbox's `setPlan` (plan.camera).
 */

import type {quat, vec3} from 'linearly'

import type {AddsubCalibration} from './config'
import {rigToWorld} from './coords'
import {anglesToRotation, type CameraPose} from './kinematics'

export function parseCameraPoseMessage(
	data: any,
	calibration: Pick<AddsubCalibration, 'rigOffset'>
): CameraPose {
	const scale = data?.unit === 'm' ? 1000 : 1
	const p = data?.position
	if (!Array.isArray(p) || p.length < 3) throw new Error('position must be [x, y, z]')
	let position: vec3 = [num(p[0], 'x') * scale, num(p[1], 'y') * scale, num(p[2], 'z') * scale]
	let rotation: quat = [0, 0, 0, 1]
	if (Array.isArray(data.rotation)) {
		if (data.rotation.length !== 4) throw new Error('rotation must be [x, y, z, w]')
		rotation = data.rotation.map((v: unknown, i: number) => num(v, `rotation[${i}]`)) as [number, number, number, number]
	} else if (data.angles) {
		rotation = anglesToRotation({
			tilt: Number(data.angles.tilt ?? 0),
			pan: Number(data.angles.pan ?? 0),
			roll: Number(data.angles.roll ?? 0),
		})
	}
	const frame = data.frame ?? 'world'
	if (frame === 'rig') position = rigToWorld(position, calibration.rigOffset)
	else if (frame !== 'world' && frame !== 'film') throw new Error(`unknown frame '${frame}'`)
	return {position, rotation}
}

function num(v: unknown, name: string): number {
	const n = Number(v)
	if (!Number.isFinite(n)) throw new Error(`${name} is not a number`)
	return n
}
