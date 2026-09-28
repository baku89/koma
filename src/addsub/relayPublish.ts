/**
 * What the shooting machine tells the exhibition screens (ADDSUB.md §15.2),
 * wired onto the generic relay store:
 *
 * - `machine:mill`, `machine:rig` — FluidNC state and positions (~10 Hz)
 * - `sequence`                    — step / status, and the G-code file + line
 *                                   being streamed to the mill
 * - the camera's live view MediaStream (WebRTC, see stores/relay.ts)
 * - the extra files of the display copy: previz/frames.json, set.json and the
 *   G-code they reference, plus per-layer G-code (addsub.layerGcode)
 */

import {watch} from 'vue'

import {useCameraStore} from '@/stores/camera'
import {useProjectStore} from '@/stores/project'
import {useRelayStore, type WantedFile} from '@/stores/relay'

import {useMillStore, useRigStore} from './stores/machines'
import {PREVIZ_DIR, usePrevizStore} from './stores/previz'
import {useSequenceStore} from './stores/sequence'

const MACHINE_RATE_MS = 100

function expand(pattern: string, n: number) {
	return pattern.replace(/%0?(\d*)d/, (_, w) => String(n).padStart(Number(w || 0), '0'))
}

export function setupAddsubRelay() {
	const relay = useRelayStore()
	const project = useProjectStore()
	const camera = useCameraStore()
	const mill = useMillStore()
	const rig = useRigStore()
	const sequence = useSequenceStore()
	const previz = usePrevizStore()

	//--------------------------------------------------------------------------
	// Machines

	for (const [topic, m] of [
		['machine:mill', mill],
		['machine:rig', rig],
	] as const) {
		watch(
			() => ({
				connected: m.connected,
				state: m.state,
				mpos: m.mpos,
				wpos: m.wpos,
				alarm: m.alarm,
				busy: m.busy,
				progress: m.streamProgress,
			}),
			v => relay.publishThrottled(topic, {...v, t: Date.now()}, MACHINE_RATE_MS),
			{immediate: true, deep: true}
		)
	}

	//--------------------------------------------------------------------------
	// Sequence (what the SEQUENCE and G-CODE panes show live)

	watch(
		() => {
			const cutting = sequence.cutting
			const p = mill.streamProgress
			return {
				running: sequence.running,
				continuous: sequence.continuous,
				step: sequence.currentStep,
				message: sequence.message,
				progress: project.addsub.sequence,
				filmLift: project.addsub.filmLift,
				captureFrame: project.captureShot.frame,
				captureLayer: project.captureShot.layer,
				gcode: cutting ? {frame: cutting.frame, path: cutting.path, index: p?.index ?? 0, total: p?.total ?? 0} : null,
			}
		},
		v => relay.publishThrottled('sequence', {...v, t: Date.now()}, MACHINE_RATE_MS),
		{immediate: true, deep: true}
	)

	//--------------------------------------------------------------------------
	// Live view (Tethr's MediaStream, whatever the camera)

	watch(
		() => camera.liveview.value ?? null,
		stream => relay.setLiveStream(stream),
		{immediate: true}
	)

	//--------------------------------------------------------------------------
	// Display copy: files besides the previews

	relay.registerExtraFiles((): WantedFile[] => {
		const out: WantedFile[] = []
		if (previz.available) {
			// One stamp for the whole previz set: when frames.json changes, every
			// referenced file is re-checked (by size + mtime) — cheap, and the only
			// time G-code can have changed.
			const v = `previz:${previz.lastModified ?? 0}`
			out.push({rel: `${PREVIZ_DIR}/frames.json`, tag: v})
			out.push({rel: `${PREVIZ_DIR}/set.json`, tag: v})
			for (const f of previz.frames.values()) {
				if (f.gcode) out.push({rel: `${PREVIZ_DIR}/${f.gcode}`, tag: v})
			}
		}
		const layerGcode = project.addsub.layerGcode ?? {}
		for (const [layerId, pattern] of Object.entries(layerGcode)) {
			const layer = project.layerIndexOf(layerId)
			if (layer < 0) continue
			project.komas.forEach((koma, frame) => {
				if (koma?.shots?.[layer]) out.push({rel: expand(pattern, frame), tag: 'static'})
			})
		}
		return out
	})

	// previz changed on disk → its files may need pushing even without a save.
	watch(
		() => previz.lastModified,
		() => relay.syncNow()
	)
}
