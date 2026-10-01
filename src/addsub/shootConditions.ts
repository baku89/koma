/**
 * Work-specific shoot conditions, added to the generic shoot-alert store
 * (stores/shootAlerts.ts) next to the user's own JS condition.
 *
 * A frame with a plan (its own or interpolated, plan.ts) is only shot when
 * the set is actually at that plan: the rig within `planTolerance` of the
 * planned pose (Grbl moves to the commanded, step-quantised position, so a
 * tolerance rather than equality) and every checked camera config at its
 * planned value. "Go to plan" brings both there; this is what confirms it.
 *
 * A frame with G-code (dropped on its cell, or planned by previz) is only
 * shot after that G-code has run to the end on the mill (cuts.ts) — unless
 * the project's `requireCut` is off for a dry run.
 */

import {useProjectStore} from '@/stores/project'
import {useShootAlertsStore} from '@/stores/shootAlerts'

import {useSequenceStore} from './stores/sequence'

export function setupAddsubShootAlerts() {
	const project = useProjectStore()
	const sequence = useSequenceStore()
	const shootAlerts = useShootAlertsStore()

	return shootAlerts.registerAlertProvider(() => {
		const {frame, layer} = project.captureShot
		return [...sequence.cutAlerts(frame, layer), ...sequence.planAlerts(frame, layer)]
	})
}
