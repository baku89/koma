/**
 * The Box Rig in work coordinates.
 *
 * People place and read the rig in the controller's work coordinates (G54:
 * the origin is the centre of the work's bottom face, the rotary zeros are
 * the head looking straight), and that is what the project stores: plans,
 * shot records, the park pose. The machine works in machine coordinates —
 * the status reports, the travel limits, the moves the sequence sends
 * (G53) — so those go through here.
 *
 * The work origin is the world origin: the controller's work coordinate
 * offset (WCO) *is* the calibration's `rigOffset` (X/Y/Z) and `rotaryZero`
 * (A/B/C). While the rig is connected the project follows what the
 * controller reports; offline the last values seen keep the numbers the same.
 */

import {defineStore} from 'pinia'
import {computed, nextTick, watch} from 'vue'

import {useProjectStore} from '@/stores/project'
import type {AxesPosition, Axis} from '@/utils/fluidnc'

import {shiftStoredRigAxes} from '../projectData'
import {useRigStore} from './machines'

/** Positions are reported to 3 decimals. */
const EPSILON = 0.0005

/** Kill the float noise of adding / subtracting an offset. */
const round = (v: number) => Math.round(v * 1000) / 1000

export const useRigWorkStore = defineStore('addsub:rigWork', () => {
	const project = useProjectStore()
	const rig = useRigStore()

	/** Machine position of the work origin, per axis. */
	const offset = computed<Required<Pick<AxesPosition, 'x' | 'y' | 'z' | 'a' | 'b' | 'c'>>>(() => {
		const {rigOffset, rotaryZero} = project.addsub.calibration
		return {x: rigOffset[0], y: rigOffset[1], z: rigOffset[2], ...rotaryZero}
	})

	function axisToWork(axis: Axis, machine: number) {
		return round(machine - ((offset.value as AxesPosition)[axis] ?? 0))
	}

	function axisToMachine(axis: Axis, work: number) {
		return round(work + ((offset.value as AxesPosition)[axis] ?? 0))
	}

	function convert(axes: AxesPosition, fn: (axis: Axis, v: number) => number) {
		const out: AxesPosition = {}
		for (const [axis, v] of Object.entries(axes) as [Axis, number | undefined][]) {
			if (v !== undefined) out[axis] = fn(axis, v)
		}
		return out
	}

	/** Machine → work coordinates (axes left out stay left out). */
	const toWork = (machine: AxesPosition) => convert(machine, axisToWork)
	/** Work → machine coordinates. */
	const toMachine = (work: AxesPosition) => convert(work, axisToMachine)

	// Follow the controller's work offset. Not while a project is loading
	// (it would be overwritten), nor for a board that hasn't said it is the rig.
	watch(
		() => [rig.wco, rig.unidentified, project.isOpening] as const,
		([wco, unidentified, opening]) => {
			if (!wco || unidentified || opening) return
			const cal = project.addsub.calibration
			const now = offset.value
			// A file converted from machine coordinates with an offset the
			// controller never confirmed: keep its axes where they physically
			// were under the real offset (machine = work + offset).
			if (project.addsub.rigRebase) {
				const delta: AxesPosition = {}
				for (const axis of ['x', 'y', 'z', 'a', 'b', 'c'] as const) {
					const v = wco[axis]
					if (v !== undefined && Math.abs(now[axis] - v) > EPSILON) delta[axis] = now[axis] - v
				}
				if (Object.keys(delta).length > 0) {
					shiftStoredRigAxes(project, delta)
					// Undo would bring back axes for the old offset.
					nextTick(() => project.history.clear())
				}
				project.addsub.rigRebase = false
			}
			const differs = (axis: Axis) => {
				const v = wco[axis]
				return v !== undefined && Math.abs(v - ((now as AxesPosition)[axis] ?? 0)) > EPSILON
			}
			if (differs('x') || differs('y') || differs('z')) {
				cal.rigOffset = [wco.x ?? now.x, wco.y ?? now.y, wco.z ?? now.z]
			}
			if (differs('a') || differs('b') || differs('c')) {
				cal.rotaryZero = {a: wco.a ?? now.a, b: wco.b ?? now.b, c: wco.c ?? now.c}
			}
		},
		{immediate: true}
	)

	return {offset, axisToWork, axisToMachine, toWork, toMachine}
})
