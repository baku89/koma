/**
 * Remote jog: lets the phone page (`/jog.html`, src/jog) drive the FluidNC
 * machines through koma-relay. The phone cannot open the serial ports (a
 * Web Serial port belongs to one tab, here koma's), so it sends `jog`
 * control messages (`role=control`) that the relay forwards to this store,
 * which calls the machine stores and answers on the `jog:result` topic.
 *
 * Only step jogs (one `$J=G91 …` per tap) — no press-and-hold: a lost
 * "release" over Wi-Fi must never leave an axis running. Anything that moves
 * is refused while `busy()` (a sequence running); stop / hold / estop are
 * always accepted.
 *
 *   control  jog        {id, machine, action, axis?, delta?, feed?, value?}
 *            action: step | cancel | hold | resume | unlock | home | reset |
 *                    zero | estop | feedOverride (value 0 | ±10 | ±1) |
 *                    rapidOverride (value 100 | 50 | 25)
 *   state    remoteJog  {enabled, machines: [id…]}
 *   state    jog:result {id, machine, action, ok, error?, t}
 */

import {defineStore} from 'pinia'
import {useTweeq} from 'tweeq'
import {readonly, ref, watch} from 'vue'

import type {Axis} from '@/utils/fluidnc'

import type {MachineStore} from './machine'
import {useRelayStore} from './relay'

export interface RemoteJogMessage {
	id?: string | number
	machine: string
	action:
		| 'step'
		| 'cancel'
		| 'hold'
		| 'resume'
		| 'unlock'
		| 'home'
		| 'reset'
		| 'zero'
		| 'estop'
		| 'feedOverride'
		| 'rapidOverride'
	axis?: Axis
	/** feedOverride: 0 (reset) | ±10 | ±1; rapidOverride: 100 | 50 | 25. */
	value?: number
	/** Step in the axis unit (mm / deg), signed. */
	delta?: number
	/** Feed override (unit/min); the machine's jog feed when absent. */
	feed?: number
}

export interface RemoteJogOptions {
	/** True while the machines must not be moved from the phone (a sequence runs). */
	busy?: () => boolean
	/** Emergency stop for everything (default: feed-hold every machine). */
	estop?: () => Promise<void> | void
}

const MAX_STEP_MM = 200
const MAX_STEP_DEG = 180

export const useRemoteJogStore = defineStore('remoteJog', () => {
	const Tq = useTweeq()
	const config = Tq.config.group('remoteJog')
	const relay = useRelayStore()

	/** Off = messages are refused (the page shows "remote jog disabled"). */
	const enabled = config.ref<boolean>('enabled', true)
	const machines = new Map<string, MachineStore>()
	let options: RemoteJogOptions = {}
	const lastMessage = ref<{machine: string; action: string; ok: boolean; error?: string; t: number} | null>(
		null
	)

	function publishInfo() {
		relay.publish('remoteJog', {enabled: enabled.value, machines: [...machines.keys()]})
	}

	/** Register the machines the phone may drive (call once, at startup). */
	function setup(stores: MachineStore[], opts: RemoteJogOptions = {}) {
		for (const m of stores) machines.set(m.def.id, m)
		options = opts
		publishInfo()
	}

	watch(enabled, publishInfo)
	relay.onConnected(publishInfo)

	function reply(msg: RemoteJogMessage, ok: boolean, error?: string) {
		lastMessage.value = {machine: msg.machine, action: msg.action, ok, error, t: Date.now()}
		relay.publish('jog:result', {id: msg.id, machine: msg.machine, action: msg.action, ok, error, t: Date.now()})
	}

	async function handle(msg: RemoteJogMessage) {
		if (!enabled.value) throw new Error('Remote jog is disabled in koma')
		if (msg.action === 'estop') {
			if (options.estop) await options.estop()
			else await Promise.allSettled([...machines.values()].map(m => m.connected && m.feedHold()))
			return
		}
		const m = machines.get(msg.machine)
		if (!m) throw new Error(`Unknown machine "${msg.machine}"`)
		if (!m.connected) throw new Error(`${m.def.label} is not connected`)
		const moving = msg.action === 'step' || msg.action === 'home' || msg.action === 'resume'
		if (moving && options.busy?.()) throw new Error('A sequence is running — stop it first')
		switch (msg.action) {
			case 'step': {
				const axis = msg.axis
				if (!axis || !m.def.axes.includes(axis)) throw new Error(`Bad axis "${axis}"`)
				const delta = Number(msg.delta)
				const unit = m.def.axisInfo?.[axis]?.unit ?? 'mm'
				const max = unit === 'deg' ? MAX_STEP_DEG : MAX_STEP_MM
				if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > max) {
					throw new Error(`Step ${delta} out of range (±${max} ${unit})`)
				}
				const feed = Number(msg.feed)
				await m.jog({[axis]: delta}, Number.isFinite(feed) && feed > 0 ? {feed} : {})
				break
			}
			case 'cancel':
				await m.jogCancel()
				break
			case 'hold':
				await m.feedHold()
				break
			case 'resume':
				await m.resume()
				break
			case 'unlock':
				await m.unlock()
				break
			case 'home':
				await m.home()
				break
			case 'reset':
				await m.reset()
				break
			case 'zero':
				await m.zeroWork()
				break
			// Overrides are real-time and meant for a running program: allowed
			// while a sequence streams G-code (that's the point of them).
			case 'feedOverride': {
				const v = Number(msg.value)
				if (![0, 10, -10, 1, -1].includes(v)) throw new Error(`Bad feed override step ${msg.value}`)
				await m.feedOverride(v as 0 | 10 | -10 | 1 | -1)
				break
			}
			case 'rapidOverride': {
				const v = Number(msg.value)
				if (![100, 50, 25].includes(v)) throw new Error(`Bad rapid override ${msg.value}`)
				await m.rapidOverride(v as 100 | 50 | 25)
				break
			}
			default:
				throw new Error(`Unknown action "${(msg as any).action}"`)
		}
	}

	relay.onControl('jog', (data: RemoteJogMessage) => {
		if (!data || typeof data !== 'object' || typeof data.action !== 'string') return
		handle(data).then(
			() => reply(data, true),
			e => reply(data, false, e instanceof Error ? e.message : String(e))
		)
	})

	return {
		enabled,
		lastMessage: readonly(lastMessage),
		setup,
	}
})
