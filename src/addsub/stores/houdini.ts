/**
 * Houdini → koma live control (ADDSUB.md §13.2), over the relay's `control`
 * channel (a `role=control` WebSocket client; see scripts/houdini/koma_bridge.py).
 *
 * Topics the capture accepts, each behind its own switch here so nothing on
 * the set moves or lights up just because Houdini is connected:
 *
 * - `led:frame`  {rgb: base64 | number[], layoutVersion?}
 *                Per-pixel colours of the whole wall in ws-fanout line order
 *                (all lines concatenated, 3 bytes per pixel). Shown as-is,
 *                no image sampling — Houdini already knows every pixel's
 *                colour (its LED point cloud's Cd). Gated by `led.liveLight`.
 * - `rig:pose`   {position:[x,y,z], rotation:[x,y,z,w] | angles:{tilt,pan,roll},
 *                 frame?: 'film' | 'world' | 'rig', unit?: 'mm' | 'm'}
 *                or {axes:{x,y,z,a,b,c}} (rig machine coords, degrees).
 *                Moves the Box Rig to follow the previz camera. Gated by
 *                `rigFollow`; refused outside `rigLimits`, while the sequence
 *                runs, or when the rig is not idle/jogging. Sent as absolute
 *                jogs, the previous jog cancelled first, so a scrubbing
 *                timeline never queues up moves.
 * - `timeline:frame` {frame}  (previz frame numbering)
 *                Moves koma's preview to that frame (onion skin / previz
 *                render comparison). Gated by `followTimeline`.
 */

import type {quat, vec3} from 'linearly'
import {defineStore} from 'pinia'
import {useTweeq} from 'tweeq'
import {computed, readonly, ref, watch} from 'vue'

import {useProjectStore} from '@/stores/project'
import {useRelayStore} from '@/stores/relay'
import {useViewportStore} from '@/stores/viewport'

import {rigToWorld, worldToFilm} from '../coords'
import {anglesToRotation, type CameraPose, cameraPoseToRigAxes, type RigTarget} from '../kinematics'
import {useLedStore} from './led'
import {useRigStore} from './machines'
import {useSequenceStore} from './sequence'

/** Minimum interval between rig jogs sent for `rig:pose` (ms). */
const RIG_FOLLOW_MIN_MS = 200
/** A pose within this distance / angle of the last sent one is not re-sent. */
const RIG_FOLLOW_EPS_MM = 0.05
const RIG_FOLLOW_EPS_DEG = 0.01

export const useHoudiniStore = defineStore('addsub:houdini', () => {
	const Tq = useTweeq()
	const project = useProjectStore()
	const relay = useRelayStore()
	const viewport = useViewportStore()
	const led = useLedStore()
	const rig = useRigStore()
	const sequence = useSequenceStore()

	/** Let `rig:pose` move the Box Rig. Never persisted: off on every launch. */
	const rigFollow = ref(false)
	/** Feed for follow jogs (mm/min); slower than the sequence's by default. */
	const rigFollowFeed = Tq.config.ref('addsub.houdini.rigFollowFeed', 600)
	/** Let `timeline:frame` move the preview frame. */
	const followTimeline = Tq.config.ref('addsub.houdini.followTimeline', true)

	const lastPose = ref<{t: number; target: RigTarget; sent: boolean; reason?: string} | null>(null)
	const lastFrame = ref<{t: number; frame: number} | null>(null)
	const error = ref<string | null>(null)

	/** Whether any controller has spoken recently (the relay tells us nothing else). */
	const lastControlAt = computed(() => relay.lastControl?.t ?? null)

	//--------------------------------------------------------------------------
	// LED

	relay.onControl('led:frame', data => {
		const rgb = decodeRgb(data?.rgb)
		if (!rgb) {
			error.value = 'led:frame: rgb must be base64 or a byte array'
			return
		}
		if (
			data?.layoutVersion !== undefined &&
			Number(data.layoutVersion) !== led.layout.version
		) {
			error.value = `led:frame: layout version ${data.layoutVersion} ≠ set.json ${led.layout.version}`
		}
		led.pushLiveFrame(rgb)
	})

	function decodeRgb(v: unknown): Uint8Array | null {
		if (typeof v === 'string') {
			try {
				const bin = atob(v)
				const out = new Uint8Array(bin.length)
				for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
				return out
			} catch {
				return null
			}
		}
		if (Array.isArray(v)) return Uint8Array.from(v, n => Math.max(0, Math.min(255, Number(n) | 0)))
		return null
	}

	//--------------------------------------------------------------------------
	// Rig

	let pendingTarget: RigTarget | null = null
	let lastSent: RigTarget | null = null
	let lastSentAt = 0
	let followTimer: ReturnType<typeof setTimeout> | null = null
	let sending = false

	relay.onControl('rig:pose', data => {
		let target: RigTarget
		try {
			target = poseMessageToTarget(data)
		} catch (e) {
			error.value = `rig:pose: ${e instanceof Error ? e.message : String(e)}`
			return
		}
		const reason = refuseReason(target)
		lastPose.value = {t: Date.now(), target, sent: false, reason}
		if (reason) return
		pendingTarget = target
		scheduleFollow()
	})

	function poseMessageToTarget(data: any): RigTarget {
		if (data?.axes) {
			const a = data.axes
			return {
				x: num(a.x, 'axes.x'),
				y: num(a.y, 'axes.y'),
				z: num(a.z, 'axes.z'),
				a: Number(a.a ?? 0),
				b: Number(a.b ?? 0),
				c: Number(a.c ?? 0),
			}
		}
		const scale = data?.unit === 'm' ? 1000 : 1
		const p = data?.position
		if (!Array.isArray(p) || p.length < 3) throw new Error('position must be [x, y, z]')
		let position: vec3 = [num(p[0], 'x') * scale, num(p[1], 'y') * scale, num(p[2], 'z') * scale]
		const rotation: quat = Array.isArray(data.rotation)
			? (data.rotation.map(Number) as [number, number, number, number])
			: data.angles
				? anglesToRotation({
						tilt: Number(data.angles.tilt ?? 0),
						pan: Number(data.angles.pan ?? 0),
						roll: Number(data.angles.roll ?? 0),
					})
				: [0, 0, 0, 1]
		const {calibration, filmLift} = project.addsub
		const frame = data.frame ?? 'film'
		if (frame === 'rig') position = rigToWorld(position, calibration.rigOffset)
		if (frame === 'rig' || frame === 'world') {
			position = worldToFilm(position, filmLift, calibration.filmOriginWorld)
		} else if (frame !== 'film') throw new Error(`unknown frame '${frame}'`)
		const pose: CameraPose = {position, rotation}
		return cameraPoseToRigAxes(pose, filmLift, calibration)
	}

	function num(v: unknown, name: string): number {
		const n = Number(v)
		if (!Number.isFinite(n)) throw new Error(`${name} is not a number`)
		return n
	}

	function refuseReason(target: RigTarget): string | undefined {
		if (!rigFollow.value) return 'follow is off'
		if (!rig.connected) return 'rig not connected'
		if (sequence.running) return 'sequence running'
		const limits = project.addsub.rigLimits
		for (const [axis, range] of Object.entries(limits)) {
			if (!range) continue
			const v = target[axis as keyof RigTarget]
			if (v < range[0] || v > range[1]) {
				return `${axis.toUpperCase()} = ${v.toFixed(2)} outside [${range[0]}, ${range[1]}]`
			}
		}
		if (rig.state !== 'Idle' && rig.state !== 'Jog') return `rig is ${rig.state ?? 'unknown'}`
		return undefined
	}

	function scheduleFollow() {
		if (followTimer || sending) return
		const wait = Math.max(0, RIG_FOLLOW_MIN_MS - (performance.now() - lastSentAt))
		followTimer = setTimeout(() => {
			followTimer = null
			void sendFollow()
		}, wait)
	}

	async function sendFollow() {
		const target = pendingTarget
		pendingTarget = null
		if (!target) return
		if (refuseReason(target)) return
		if (lastSent && sameTarget(lastSent, target)) return
		sending = true
		try {
			if (rig.state === 'Jog') rig.jogCancel()
			await rig.jog(target, {feed: rigFollowFeed.value, relative: false, machineCoords: true})
			lastSent = target
			lastSentAt = performance.now()
			if (lastPose.value && lastPose.value.target === target) lastPose.value = {...lastPose.value, sent: true}
			error.value = null
		} catch (e) {
			error.value = `rig:pose: ${e instanceof Error ? e.message : String(e)}`
		} finally {
			sending = false
			if (pendingTarget) scheduleFollow()
		}
	}

	function sameTarget(a: RigTarget, b: RigTarget) {
		return (
			Math.abs(a.x - b.x) < RIG_FOLLOW_EPS_MM &&
			Math.abs(a.y - b.y) < RIG_FOLLOW_EPS_MM &&
			Math.abs(a.z - b.z) < RIG_FOLLOW_EPS_MM &&
			Math.abs(a.a - b.a) < RIG_FOLLOW_EPS_DEG &&
			Math.abs(a.b - b.b) < RIG_FOLLOW_EPS_DEG &&
			Math.abs(a.c - b.c) < RIG_FOLLOW_EPS_DEG
		)
	}

	// Switching follow off mid-move stops the rig where it is.
	watch(rigFollow, on => {
		pendingTarget = null
		lastSent = null
		if (!on && rig.connected && rig.state === 'Jog') rig.jogCancel()
	})
	// The sequence taking over cancels any follow jog in flight.
	watch(
		() => sequence.running,
		running => {
			if (running) {
				pendingTarget = null
				if (rigFollow.value) rigFollow.value = false
			}
		}
	)

	//--------------------------------------------------------------------------
	// Timeline

	relay.onControl('timeline:frame', data => {
		const previzFrame = Number(data?.frame)
		if (!Number.isFinite(previzFrame)) return
		lastFrame.value = {t: Date.now(), frame: previzFrame}
		if (!followTimeline.value) return
		viewport.setCurrentFrame(Math.round(previzFrame) - project.addsub.previzFrameOffset)
	})

	return {
		rigFollow,
		rigFollowFeed,
		followTimeline,
		lastPose: readonly(lastPose),
		lastFrame: readonly(lastFrame),
		lastControlAt,
		error,
	}
})
