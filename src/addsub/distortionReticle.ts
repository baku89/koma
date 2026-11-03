/**
 * The marker reticle on the Preview for the distortion calibration
 * (stores/rigDistortion.ts): a centre cross and, when the lens table knows the
 * focal, the square the marker's face should fill seen square-on from the
 * calibration radius. Matching the live view to it is how a point is trued
 * up: a face off-centre = position, keystoned = aim, tilted = roll, the
 * wrong size = distance.
 */

import {usePreviewOverlaysStore} from '@/stores/previewOverlays'
import {useProjectStore} from '@/stores/project'

import {reticleHalfWidth} from './rigDistortion'
import {useLensStore} from './stores/lens'
import {useRigDistortionStore} from './stores/rigDistortion'

export function setupDistortionReticle() {
	const project = useProjectStore()
	const overlays = usePreviewOverlaysStore()
	const distortion = useRigDistortionStore()
	const lens = useLensStore()

	return overlays.register(() => {
		if (!distortion.reticle) return null
		const {markerSize, radii} = distortion.data
		// The face is at the active point's radius (the one Go sent to), else the first.
		const radius = distortion.activePoint?.point.radius ?? radii[0] ?? 0
		const [w, h] = project.resolution
		const aspect = w > 0 && h > 0 ? w / h : 1.5
		// Like the project's own guide lines (Preview.vue `.line`): a 2 px
		// stroke whatever the picture is scaled to.
		const stroke = 'stroke="rgba(255, 220, 80, 0.9)" stroke-width="2px" fill="none" vector-effect="non-scaling-stroke"'
		const parts = [
			`<line x1="0.5" y1="0.44" x2="0.5" y2="0.56" ${stroke} />`,
			`<line x1="0.46" y1="0.5" x2="0.54" y2="0.5" ${stroke} />`,
		]
		// Pupil distance to the face: the nominal poses put the pupil `radius`
		// from the base point, where the face is.
		const focal = lens.current?.focal
		if (focal) {
			const hw = reticleHalfWidth(markerSize, radius, focal, project.addsub.lens.sensorWidth)
			const hh = hw * aspect
			if (hw > 0 && hw < 0.5) {
				parts.push(
					`<rect x="${0.5 - hw}" y="${0.5 - hh}" width="${2 * hw}" height="${2 * hh}" ${stroke} />`
				)
				// Ticks at the midpoints of the sides: the face's edges should run through them.
				const t = 0.015
				parts.push(
					`<line x1="0.5" y1="${0.5 - hh - t}" x2="0.5" y2="${0.5 - hh + t}" ${stroke} />`,
					`<line x1="0.5" y1="${0.5 + hh - t}" x2="0.5" y2="${0.5 + hh + t}" ${stroke} />`,
					`<line x1="${0.5 - hw - t}" y1="0.5" x2="${0.5 - hw + t}" y2="0.5" ${stroke} />`,
					`<line x1="${0.5 + hw - t}" y1="0.5" x2="${0.5 + hw + t}" y2="0.5" ${stroke} />`
				)
			}
		}
		return parts.join('')
	})
}
