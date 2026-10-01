/**
 * Minimal FluidNC / Grbl client over the Web Serial API.
 *
 * Design (see ADDSUB.md §3.5):
 * - One G-code line in flight at a time: `send()` writes `line\n` and resolves
 *   on `ok`, rejects on `error:N` / `ALARM:N`. No character counting — the
 *   FluidNC RX buffer can't overflow this way and progress is exact.
 * - Real-time bytes (`?`, `!`, `~`, 0x18, 0x85 …) bypass the queue and are
 *   written raw (a TextEncoder would mangle 0x85 into two UTF-8 bytes).
 * - Status is polled with `?` on a timer and pushed as `status` events. `WCO`
 *   is only reported every few polls, so the last one seen is merged in.
 * - Opening the port typically resets the ESP32 (DTR/RTS); `open()` waits for
 *   the board to answer before resolving.
 *
 * DOM-only (navigator.serial). The pure parsing lives in ./status.
 */

import {EventEmitter} from 'eventemitter3'

import {
	ALARM_MESSAGES,
	type BuildInfo,
	classifyLine,
	ERROR_MESSAGES,
	type MachineStatus,
	mposToWpos,
	parseBuildInfo,
} from './status'

export const Realtime = {
	statusReport: 0x3f, // '?'
	feedHold: 0x21, // '!'
	cycleStart: 0x7e, // '~'
	softReset: 0x18, // Ctrl-X
	safetyDoor: 0x84,
	jogCancel: 0x85,
	/** Toggles the spindle while in feed hold (Grbl 1.1 / FluidNC). */
	spindleStopToggle: 0x9e,
	// Grbl 1.1 overrides (what cncjs' feed-override slider sends): real-time,
	// applied at once to the running program; 10–200 % in steps, echoed back
	// in the `Ov:` field of status reports.
	feedOverrideReset: 0x90,
	feedOverridePlus10: 0x91,
	feedOverrideMinus10: 0x92,
	feedOverridePlus1: 0x93,
	feedOverrideMinus1: 0x94,
	rapidOverrideReset: 0x95,
	rapidOverride50: 0x96,
	rapidOverride25: 0x97,
	spindleOverrideReset: 0x99,
} as const

export type FeedOverrideStep = 0 | 10 | -10 | 1 | -1
export type RapidOverride = 100 | 50 | 25

export class FluidNCError extends Error {
	constructor(
		public readonly kind: 'error' | 'alarm' | 'disconnected' | 'timeout' | 'aborted',
		public readonly code: number | undefined,
		message: string
	) {
		super(message)
		this.name = 'FluidNCError'
	}
}

export interface FluidNCClientOptions {
	/** @default 115200 */
	baudRate?: number
	/** ms between `?` polls. 0 disables polling. @default 200 */
	statusInterval?: number
	/** ms to wait for the board to answer after opening the port. @default 4000 */
	bootTimeout?: number
	/** Default per-command timeout in ms (0 = none). Long moves are acked when
	 * *accepted*, not when finished, so this only guards a dead link. @default 10000 */
	commandTimeout?: number
}

export interface SendOptions {
	timeout?: number
	signal?: AbortSignal
}

export interface StreamOptions {
	signal?: AbortSignal
	/** Called after each line is acknowledged. */
	onProgress?: (info: {index: number; total: number; line: string}) => void
}

export interface WaitOptions {
	timeout?: number
	signal?: AbortSignal
}

type Events = {
	/** Every line received, before classification (for a raw console). */
	line: [string]
	/** Every line sent. */
	sent: [string]
	status: [MachineStatus]
	message: [string]
	alarm: [{code: number; message: string}]
	/** Board banner seen: it (re)booted. */
	reset: []
	disconnect: []
}

interface Pending {
	line: string
	resolve: (lines: string[]) => void
	reject: (err: Error) => void
	collected: string[]
	timer?: ReturnType<typeof setTimeout>
	onAbort?: () => void
}

export class FluidNCClient extends EventEmitter<Events> {
	readonly port: SerialPort
	readonly options: Required<FluidNCClientOptions>

	#reader: ReadableStreamDefaultReader<Uint8Array> | null = null
	#writer: WritableStreamDefaultWriter<Uint8Array> | null = null
	#writeChain: Promise<unknown> = Promise.resolve()
	#queue: Pending[] = []
	#inFlight: Pending | null = null
	#closed = true
	#statusTimer: ReturnType<typeof setInterval> | null = null
	#lastWco: MachineStatus['wco'] | undefined
	#status: MachineStatus | null = null
	#statusWaiters = new Set<(s: MachineStatus) => void>()

	constructor(port: SerialPort, options: FluidNCClientOptions = {}) {
		super()
		this.port = port
		this.options = {
			baudRate: options.baudRate ?? 115200,
			statusInterval: options.statusInterval ?? 200,
			bootTimeout: options.bootTimeout ?? 4000,
			commandTimeout: options.commandTimeout ?? 10000,
		}
	}

	get isOpen() {
		return !this.#closed
	}

	/** Last status report, with the last-seen WCO merged in. */
	get status(): MachineStatus | null {
		return this.#status
	}

	//--------------------------------------------------------------------------
	// Lifecycle

	async open() {
		if (!this.#closed) return

		await this.port.open({baudRate: this.options.baudRate})
		if (!this.port.readable || !this.port.writable) {
			throw new Error('Serial port opened without streams')
		}

		this.#closed = false
		this.#reader = this.port.readable.getReader()
		this.#writer = this.port.writable.getWriter()

		this.port.addEventListener('disconnect', this.#onPortDisconnect)
		void this.#readLoop()

		// The board may have just reset. Poke it with `?` until a status report
		// comes back (or give up).
		const deadline = Date.now() + this.options.bootTimeout
		let alive = false
		while (Date.now() < deadline && !this.#closed) {
			const got = await this.#pollOnce(300)
			if (got) {
				alive = true
				break
			}
		}
		if (!alive) {
			await this.close()
			throw new FluidNCError(
				'timeout',
				undefined,
				'No response from the controller after opening the port'
			)
		}

		if (this.options.statusInterval > 0) {
			this.#statusTimer = setInterval(() => {
				void this.requestStatus()
			}, this.options.statusInterval)
		}
	}

	async close() {
		if (this.#closed) return
		this.#closed = true

		if (this.#statusTimer) clearInterval(this.#statusTimer)
		this.#statusTimer = null
		this.port.removeEventListener('disconnect', this.#onPortDisconnect)

		this.#failAll(
			new FluidNCError('disconnected', undefined, 'Port closed')
		)

		try {
			await this.#reader?.cancel()
		} catch {
			// ignore
		}
		try {
			this.#reader?.releaseLock()
		} catch {
			// ignore
		}
		try {
			await this.#writer?.close()
		} catch {
			// ignore
		}
		try {
			this.#writer?.releaseLock()
		} catch {
			// ignore
		}
		this.#reader = null
		this.#writer = null
		try {
			await this.port.close()
		} catch {
			// ignore — already gone
		}
		this.emit('disconnect')
	}

	#onPortDisconnect = () => {
		void this.close()
	}

	//--------------------------------------------------------------------------
	// Low-level I/O

	async #writeBytes(bytes: Uint8Array) {
		const writer = this.#writer
		if (!writer || this.#closed) {
			throw new FluidNCError('disconnected', undefined, 'Port is not open')
		}
		// Serialise writes: a WritableStream writer rejects overlapping writes.
		const p = this.#writeChain.then(() => writer.write(bytes))
		this.#writeChain = p.catch(() => {})
		await p
	}

	async #readLoop() {
		const reader = this.#reader
		if (!reader) return
		const decoder = new TextDecoder()
		let buf = ''
		try {
			for (;;) {
				const {value, done} = await reader.read()
				if (done) break
				buf += decoder.decode(value, {stream: true})
				let nl: number
				while ((nl = buf.indexOf('\n')) !== -1) {
					const line = buf.slice(0, nl).replace(/\r$/, '')
					buf = buf.slice(nl + 1)
					if (line.length) this.#onLine(line)
				}
			}
		} catch {
			// Reader error → the device went away.
		}
		if (!this.#closed) void this.close()
	}

	#onLine(line: string) {
		this.emit('line', line)
		const msg = classifyLine(line)

		switch (msg.type) {
			case 'status': {
				const status = msg.status
				if (status.wco) this.#lastWco = status.wco
				else if (this.#lastWco) status.wco = this.#lastWco
				if (status.mpos && status.wco && !status.wpos) {
					status.wpos = mposToWpos(status.mpos, status.wco)
				}
				this.#status = status
				for (const w of this.#statusWaiters) w(status)
				this.emit('status', status)
				return
			}
			case 'ok':
				this.#settle(p => p.resolve(p.collected))
				return
			case 'error': {
				const text = ERROR_MESSAGES[msg.code] ?? 'Unknown error'
				this.#settle(p =>
					p.reject(
						new FluidNCError(
							'error',
							msg.code,
							`error:${msg.code} ${text} — "${p.line}"`
						)
					)
				)
				return
			}
			case 'alarm': {
				const text = ALARM_MESSAGES[msg.code] ?? 'Unknown alarm'
				this.emit('alarm', {code: msg.code, message: text})
				this.#settle(p =>
					p.reject(new FluidNCError('alarm', msg.code, `ALARM:${msg.code} ${text}`))
				)
				return
			}
			case 'message':
				this.emit('message', msg.text)
				this.#inFlight?.collected.push(line)
				return
			case 'banner':
				// The controller rebooted (soft reset or power cycle): whatever was
				// in flight is gone.
				this.#failAll(
					new FluidNCError('disconnected', undefined, 'Controller reset')
				)
				this.emit('reset')
				return
			default:
				this.#inFlight?.collected.push(line)
		}
	}

	//--------------------------------------------------------------------------
	// Command queue

	#settle(fn: (p: Pending) => void) {
		const p = this.#inFlight
		if (!p) return
		this.#inFlight = null
		this.#cleanupPending(p)
		fn(p)
		this.#pump()
	}

	#cleanupPending(p: Pending) {
		if (p.timer) clearTimeout(p.timer)
		p.onAbort?.()
	}

	#failAll(err: Error) {
		const all = [...(this.#inFlight ? [this.#inFlight] : []), ...this.#queue]
		this.#inFlight = null
		this.#queue = []
		for (const p of all) {
			this.#cleanupPending(p)
			p.reject(err)
		}
	}

	#pump() {
		if (this.#inFlight || this.#closed) return
		const next = this.#queue.shift()
		if (!next) return
		this.#inFlight = next
		this.emit('sent', next.line)
		this.#writeBytes(new TextEncoder().encode(next.line + '\n')).catch(
			err => {
				if (this.#inFlight === next) {
					this.#inFlight = null
					this.#cleanupPending(next)
					next.reject(err instanceof Error ? err : new Error(String(err)))
					this.#pump()
				}
			}
		)
	}

	/**
	 * Queue one line and resolve with any non-`ok` lines the controller printed
	 * before its `ok` (e.g. `$$` settings, `$I` build info, `$#` offsets).
	 */
	send(line: string, opts: SendOptions = {}): Promise<string[]> {
		const clean = line.replace(/[\r\n]+$/, '')
		return new Promise<string[]>((resolve, reject) => {
			if (this.#closed) {
				reject(new FluidNCError('disconnected', undefined, 'Port is not open'))
				return
			}
			if (opts.signal?.aborted) {
				reject(new FluidNCError('aborted', undefined, 'Aborted'))
				return
			}
			const pending: Pending = {line: clean, resolve, reject, collected: []}

			const timeout = opts.timeout ?? this.options.commandTimeout
			if (timeout > 0) {
				pending.timer = setTimeout(() => {
					this.#drop(
						pending,
						new FluidNCError(
							'timeout',
							undefined,
							`No "ok" within ${timeout} ms for "${clean}"`
						)
					)
				}, timeout)
			}
			if (opts.signal) {
				const onAbort = () =>
					this.#drop(pending, new FluidNCError('aborted', undefined, 'Aborted'))
				opts.signal.addEventListener('abort', onAbort, {once: true})
				pending.onAbort = () =>
					opts.signal?.removeEventListener('abort', onAbort)
			}

			this.#queue.push(pending)
			this.#pump()
		})
	}

	#drop(p: Pending, err: Error) {
		if (this.#inFlight === p) {
			// Can't un-send it; the eventual `ok` will just settle nothing.
			this.#inFlight = null
			this.#cleanupPending(p)
			p.reject(err)
			this.#pump()
		} else {
			const i = this.#queue.indexOf(p)
			if (i !== -1) {
				this.#queue.splice(i, 1)
				this.#cleanupPending(p)
				p.reject(err)
			}
		}
	}

	/** Number of lines waiting (incl. the one in flight). */
	get pendingCount() {
		return this.#queue.length + (this.#inFlight ? 1 : 0)
	}

	/**
	 * Send lines one by one, each waiting for its `ok`. Stops at the first
	 * error or when `signal` aborts (the controller keeps executing what it
	 * already accepted — pair with `feedHold()` / `softReset()` to stop motion).
	 */
	async stream(lines: readonly string[], opts: StreamOptions = {}) {
		for (let i = 0; i < lines.length; i++) {
			if (opts.signal?.aborted) {
				throw new FluidNCError('aborted', undefined, 'Aborted')
			}
			await this.send(lines[i], {signal: opts.signal, timeout: 0})
			opts.onProgress?.({index: i, total: lines.length, line: lines[i]})
		}
	}

	//--------------------------------------------------------------------------
	// Real-time commands

	async realtime(byte: number) {
		await this.#writeBytes(new Uint8Array([byte]))
	}

	/** `?` — a status report will arrive as a `status` event. */
	requestStatus() {
		return this.realtime(Realtime.statusReport).catch(() => {})
	}

	feedHold() {
		return this.realtime(Realtime.feedHold)
	}

	cycleStart() {
		return this.realtime(Realtime.cycleStart)
	}

	jogCancel() {
		return this.realtime(Realtime.jogCancel)
	}

	/** Stop the spindle during a feed hold (toggle; only acts while held). */
	spindleStopToggle() {
		return this.realtime(Realtime.spindleStopToggle)
	}

	/** Feed override: `0` resets to 100 %, else ±10 / ±1 % (clamped 10–200 by the controller). */
	feedOverride(step: FeedOverrideStep) {
		const byte = {
			0: Realtime.feedOverrideReset,
			10: Realtime.feedOverridePlus10,
			[-10]: Realtime.feedOverrideMinus10,
			1: Realtime.feedOverridePlus1,
			[-1]: Realtime.feedOverrideMinus1,
		}[step]
		return this.realtime(byte)
	}

	/** Rapid (G0) override: 100, 50 or 25 %. */
	rapidOverride(percent: RapidOverride) {
		const byte = {
			100: Realtime.rapidOverrideReset,
			50: Realtime.rapidOverride50,
			25: Realtime.rapidOverride25,
		}[percent]
		return this.realtime(byte)
	}

	/** Ctrl-X. Clears queued lines; the controller re-emits its banner. */
	async softReset() {
		this.#failAll(new FluidNCError('aborted', undefined, 'Soft reset'))
		await this.realtime(Realtime.softReset)
	}

	//--------------------------------------------------------------------------
	// Higher-level helpers

	/** `?` once and resolve with the report (or null on timeout). */
	#pollOnce(timeout: number): Promise<MachineStatus | null> {
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				this.#statusWaiters.delete(waiter)
				resolve(null)
			}, timeout)
			const waiter = (s: MachineStatus) => {
				clearTimeout(timer)
				this.#statusWaiters.delete(waiter)
				resolve(s)
			}
			this.#statusWaiters.add(waiter)
			void this.requestStatus()
		})
	}

	/** Resolve with the next status report that satisfies `predicate`. */
	waitFor(
		predicate: (s: MachineStatus) => boolean,
		opts: WaitOptions = {}
	): Promise<MachineStatus> {
		return new Promise((resolve, reject) => {
			if (this.#closed) {
				reject(new FluidNCError('disconnected', undefined, 'Port is not open'))
				return
			}
			let timer: ReturnType<typeof setTimeout> | undefined
			const cleanup = () => {
				this.#statusWaiters.delete(waiter)
				if (timer) clearTimeout(timer)
				opts.signal?.removeEventListener('abort', onAbort)
				this.off('disconnect', onDisconnect)
			}
			const waiter = (s: MachineStatus) => {
				if (!predicate(s)) return
				cleanup()
				resolve(s)
			}
			const onAbort = () => {
				cleanup()
				reject(new FluidNCError('aborted', undefined, 'Aborted'))
			}
			const onDisconnect = () => {
				cleanup()
				reject(new FluidNCError('disconnected', undefined, 'Disconnected'))
			}
			if (opts.timeout) {
				timer = setTimeout(() => {
					cleanup()
					reject(
						new FluidNCError('timeout', undefined, 'Timed out waiting for state')
					)
				}, opts.timeout)
			}
			opts.signal?.addEventListener('abort', onAbort, {once: true})
			this.once('disconnect', onDisconnect)
			this.#statusWaiters.add(waiter)
			if (this.options.statusInterval <= 0) void this.requestStatus()
		})
	}

	/**
	 * Wait until the machine reports `Idle` for `settle` consecutive polls.
	 * An `ok` for a motion line only means "accepted into the planner", and the
	 * very next poll can still say Idle before the planner starts — requiring a
	 * couple of consecutive Idle reports (and at least one poll interval) closes
	 * that window. Rejects if an alarm shows up.
	 */
	async waitIdle(opts: WaitOptions & {settle?: number} = {}) {
		const settle = Math.max(1, opts.settle ?? 2)
		let count = 0
		// Skip the report that may already be in the pipe from before the last
		// command was accepted.
		let skipped = false
		return this.waitFor(s => {
			if (!skipped) {
				skipped = true
				return false
			}
			if (s.state === 'Alarm') {
				throw new FluidNCError('alarm', undefined, 'Machine is in Alarm')
			}
			count = s.state === 'Idle' ? count + 1 : 0
			return count >= settle
		}, opts)
	}

	/** `$I` → build info incl. the FluidNC `name:` from config.yaml. */
	async getBuildInfo(): Promise<BuildInfo> {
		const lines = await this.send('$I', {timeout: 3000})
		return parseBuildInfo(lines)
	}

	/** `$X` — clear an alarm without homing. */
	unlock() {
		return this.send('$X', {timeout: 3000})
	}

	/** `$H` / `$H<axis>` — run the homing cycle. Resolves when it reports ok. */
	home(axes?: readonly string[], opts: SendOptions = {}) {
		const timeout = opts.timeout ?? 0
		if (!axes || axes.length === 0) return this.send('$H', {...opts, timeout})
		return this.send(`$H${axes.map(a => a.toUpperCase()).join('')}`, {
			...opts,
			timeout,
		})
	}
}
