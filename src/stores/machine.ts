/**
 * Pinia store factory for one FluidNC-controlled machine (a mill, a motion
 * control rig, …) connected over Web Serial.
 *
 * Several machines can share one USB serial chip model, so a saved
 * `SerialPortInfo` (vendor/product id) cannot tell them apart. Instead every
 * paired port is opened once, asked `$I`, and handed to the machine whose
 * `fluidncName` matches the controller's `name:` (from its config.yaml). This
 * runs at startup and whenever a port is (re)plugged, so a reload or a PC
 * sleep recovers without a picker (`navigator.serial.getPorts()` needs no
 * user gesture; `requestPort()` does). Port ownership across device families
 * (e.g. an LED driver on the same chip) is arbitrated by utils/serialDiscovery.
 */

import {defineStore} from 'pinia'
import {useTweeq} from 'tweeq'
import {computed, readonly, ref, shallowRef, watch} from 'vue'

import {
	type AxesPosition,
	type Axis,
	type BuildInfo,
	FluidNCClient,
	FluidNCError,
	jogLine,
	type JogOptions,
	machineMoveLine,
	type MachineStatus,
	type StreamOptions,
	type WaitOptions,
} from '@/utils/fluidnc'
import {
	claimSerialPort,
	discoverSerialPorts,
	registerSerialFamily,
	releaseSerialPort,
	requestSerialPortFor,
	resetRejections,
	type SerialFamily,
} from '@/utils/serialDiscovery'

export interface AxisInfo {
	unit: 'mm' | 'deg'
	label?: string
}

export interface MachineDefinition {
	/** Short stable id, used for config keys and the store id. */
	id: string
	label: string
	/**
	 * FluidNC `name:` to match when identifying a port. Undefined = accept any
	 * controller (only sensible with a single machine).
	 */
	fluidncName?: string
	axes: readonly Axis[]
	axisInfo?: Partial<Record<Axis, AxisInfo>>
	/** Default jog feed (mm/min or deg/min). */
	jogFeed?: number
	baudRate?: number
	statusInterval?: number
}

const LOG_LIMIT = 500

//------------------------------------------------------------------------------
// Port discovery: all FluidNC machines form one "family" (utils/serialDiscovery)
// so a port is identified with $I once and handed to whichever machine claims
// that name — never re-opened per machine (opening a port can reset the board).

interface Registration {
	def: MachineDefinition
	/** The current user-editable name (config override). */
	name: () => string | undefined
	adopt: (client: FluidNCClient, info: BuildInfo) => void
	hasClient: () => boolean
}

const registrations = new Map<string, Registration>()

function findOwner(info: BuildInfo, preferred?: string): Registration | null {
	const name = info.machineName
	const regs = [...registrations.values()]
	// Exact name match first (the preferred machine wins a tie).
	const byName = regs.filter(r => name !== undefined && r.name() === name)
	if (byName.length) {
		return byName.find(r => r.def.id === preferred) ?? byName[0]
	}
	// Otherwise an unconstrained machine (no name required) may take it.
	const open = regs.filter(r => r.name() === undefined && !r.hasClient())
	return open.find(r => r.def.id === preferred) ?? open[0] ?? null
}

async function identify(
	port: SerialPort,
	options: {baudRate?: number; statusInterval?: number}
): Promise<{client: FluidNCClient; info: BuildInfo}> {
	const client = new FluidNCClient(port, options)
	await client.open()
	try {
		const info = await client.getBuildInfo()
		return {client, info}
	} catch (e) {
		await client.close()
		throw e
	}
}

const FAMILY_ID = 'fluidnc'

/**
 * Probe a port as FluidNC and hand it to the matching machine. `preferred`
 * breaks ties when the user picked the port from that machine's panel.
 */
async function probe(port: SerialPort, preferred?: string): Promise<boolean> {
	const wanting = [...registrations.values()].filter(r => !r.hasClient())
	if (wanting.length === 0) return false
	const first = wanting.find(r => r.def.id === preferred) ?? wanting[0]
	let client: FluidNCClient
	let info: BuildInfo
	try {
		;({client, info} = await identify(port, {
			baudRate: first.def.baudRate,
			statusInterval: first.def.statusInterval,
		}))
	} catch {
		return false
	}
	const owner = findOwner(info, preferred)
	if (owner && !owner.hasClient()) {
		owner.adopt(client, info)
		lastProbe = {name: info.machineName, ownerId: owner.def.id}
		return true
	}
	lastProbe = {name: info.machineName, ownerId: null}
	await client.close()
	return false
}

/** What the most recent probe found — for the panel's error message. */
let lastProbe: {name: string | undefined; ownerId: string | null} | null = null

// Read through a function so TS doesn't narrow the module-level `let` to null
// across the awaits in connect().
function getLastProbe() {
	return lastProbe
}

const family: SerialFamily = {
	id: FAMILY_ID,
	wants: () => [...registrations.values()].some(r => !r.hasClient()),
	probe: port => probe(port),
}

registerSerialFamily(family)

//------------------------------------------------------------------------------

export function defineMachineStore(def: MachineDefinition) {
	return defineStore(`machine:${def.id}`, () => {
		const Tq = useTweeq()
		const config = Tq.config.group(`machine.${def.id}`)

		/** Editable override of the FluidNC name to match (persisted). */
		const fluidncName = config.ref<string>('fluidncName', def.fluidncName ?? '')
		const jogFeed = config.ref('jogFeed', def.jogFeed ?? 1000)
		const jogStep = config.ref('jogStep', 1)

		const client = shallowRef<FluidNCClient | null>(null)
		const connecting = ref(false)
		const status = ref<MachineStatus | null>(null)
		const buildInfo = ref<BuildInfo | null>(null)
		const alarm = ref<{code: number; message: string} | null>(null)
		const lastError = ref<string | null>(null)
		const log = ref<{dir: 'rx' | 'tx' | 'sys'; text: string; t: number}[]>([])
		const busy = ref(false)
		const streamProgress = ref<{index: number; total: number} | null>(null)

		const connected = computed(() => client.value !== null)
		const state = computed(() => status.value?.state ?? null)
		const mpos = computed<AxesPosition>(() => status.value?.mpos ?? {})
		const wpos = computed<AxesPosition>(() => status.value?.wpos ?? mpos.value)
		const isIdle = computed(() => state.value === 'Idle')

		function pushLog(dir: 'rx' | 'tx' | 'sys', text: string) {
			log.value.push({dir, text, t: Date.now()})
			if (log.value.length > LOG_LIMIT) log.value.splice(0, log.value.length - LOG_LIMIT)
		}

		function adopt(c: FluidNCClient, info: BuildInfo) {
			claimSerialPort(c.port, FAMILY_ID)
			client.value = c
			buildInfo.value = info
			status.value = c.status
			alarm.value = null
			lastError.value = null
			pushLog(
				'sys',
				`Connected: ${info.machineName ?? '(unnamed)'} ${info.version ?? ''}`
			)

			c.on('status', s => {
				status.value = s
				if (s.state !== 'Alarm') alarm.value = null
			})
			c.on('line', l => pushLog('rx', l))
			c.on('sent', l => pushLog('tx', l))
			c.on('alarm', a => {
				alarm.value = a
			})
			c.on('reset', () => pushLog('sys', 'Controller reset'))
			c.on('disconnect', () => {
				if (client.value !== c) return
				releaseSerialPort(c.port)
				client.value = null
				status.value = null
				busy.value = false
				streamProgress.value = null
				pushLog('sys', 'Disconnected')
			})
		}

		registrations.set(def.id, {
			def,
			name: () => fluidncName.value || undefined,
			adopt,
			hasClient: () => client.value !== null,
		})

		// Silent reconnect on startup (no user gesture needed for paired ports).
		void discoverSerialPorts()

		// Editing the expected name may make a previously rejected port match.
		watch(fluidncName, () => {
			resetRejections(FAMILY_ID)
			void discoverSerialPorts()
		})

		//----------------------------------------------------------------------
		// Connection

		/** Prompt for a port (needs a user gesture) and identify it. */
		async function connect() {
			if (client.value || connecting.value) return
			connecting.value = true
			lastProbe = null
			try {
				const result = await requestSerialPortFor({
					...family,
					probe: port => probe(port, def.id),
				})
				const found = getLastProbe()
				switch (result) {
					case 'cancelled':
						break
					case 'owned':
						lastError.value = 'That port is already in use by another device'
						break
					case 'rejected':
						lastError.value = found?.name
							? `Controller "${found.name}" doesn't match "${fluidncName.value}"`
							: 'No FluidNC controller answered on that port'
						break
					case 'adopted':
						if (!client.value && found?.ownerId) {
							const other = registrations.get(found.ownerId)
							lastError.value = `That controller is "${found.name}" — connected it as ${other?.def.label ?? found.ownerId}`
						}
						break
				}
			} catch (e) {
				lastError.value = e instanceof Error ? e.message : String(e)
			} finally {
				connecting.value = false
			}
		}

		async function disconnect() {
			const c = client.value
			if (!c) return
			await c.close()
		}

		function requireClient(): FluidNCClient {
			const c = client.value
			if (!c) throw new FluidNCError('disconnected', undefined, `${def.label} is not connected`)
			return c
		}

		//----------------------------------------------------------------------
		// Commands

		async function send(line: string) {
			try {
				return await requireClient().send(line)
			} catch (e) {
				lastError.value = e instanceof Error ? e.message : String(e)
				throw e
			}
		}

		async function stream(lines: readonly string[], opts: StreamOptions = {}) {
			const c = requireClient()
			busy.value = true
			streamProgress.value = {index: 0, total: lines.length}
			try {
				await c.stream(lines, {
					...opts,
					onProgress: p => {
						streamProgress.value = {index: p.index + 1, total: p.total}
						opts.onProgress?.(p)
					},
				})
			} catch (e) {
				lastError.value = e instanceof Error ? e.message : String(e)
				throw e
			} finally {
				busy.value = false
				streamProgress.value = null
			}
		}

		function jog(axes: AxesPosition, opts: Partial<JogOptions> = {}) {
			return send(jogLine(axes, {feed: opts.feed ?? jogFeed.value, ...opts}))
		}

		/** Jog one axis by ±jogStep. */
		function jogStepAxis(axis: Axis, sign: 1 | -1) {
			return jog({[axis]: sign * jogStep.value})
		}

		function jogCancel() {
			return requireClient().jogCancel()
		}

		async function home(axes?: readonly Axis[]) {
			busy.value = true
			try {
				await send(axes?.length ? `$H${axes.map(a => a.toUpperCase()).join('')}` : '$H')
			} finally {
				busy.value = false
			}
		}

		async function unlock() {
			await send('$X')
			alarm.value = null
		}

		async function reset() {
			await requireClient().softReset()
			busy.value = false
			streamProgress.value = null
		}

		function feedHold() {
			return requireClient().feedHold()
		}

		function resume() {
			return requireClient().cycleStart()
		}

		function waitIdle(opts?: WaitOptions & {settle?: number}) {
			return requireClient().waitIdle(opts)
		}

		/**
		 * Absolute move in machine coordinates (G53) and wait until the machine
		 * is idle again.
		 */
		async function moveTo(
			target: AxesPosition,
			opts: {feed?: number; signal?: AbortSignal; timeout?: number} = {}
		) {
			await send(machineMoveLine(target, opts.feed))
			await waitIdle({signal: opts.signal, timeout: opts.timeout})
		}

		return {
			def,
			fluidncName,
			jogFeed,
			jogStep,
			client,
			connected,
			connecting: readonly(connecting),
			status: readonly(status),
			state,
			mpos,
			wpos,
			isIdle,
			buildInfo: readonly(buildInfo),
			alarm: readonly(alarm),
			lastError,
			log: readonly(log),
			busy: readonly(busy),
			streamProgress: readonly(streamProgress),
			connect,
			disconnect,
			send,
			stream,
			jog,
			jogStepAxis,
			jogCancel,
			home,
			unlock,
			reset,
			feedHold,
			resume,
			waitIdle,
			moveTo,
		}
	})
}

export type MachineStore = ReturnType<ReturnType<typeof defineMachineStore>>
