/**
 * Coordinates Web Serial ports between several device "families" (FluidNC
 * controllers, an LED driver, …) that may all sit behind the same USB-serial
 * chip, so `SerialPortInfo` (vendor/product id) cannot tell them apart.
 *
 * Each family registers a `probe(port)` that opens the port, talks its own
 * protocol to identify the device, and either keeps the port (returns true)
 * or closes it (returns false). Probing is serialised globally so two
 * families never open the same port at once, and a port rejected by a family
 * is not offered to it again until `resetRejections()`.
 *
 * `discoverSerialPorts()` runs over `navigator.serial.getPorts()` — the
 * already-granted ports — which needs no user gesture, so it is what makes a
 * reload, a PC sleep or a replug recover silently. Granting a *new* port
 * still needs `requestPort()` from a click: `requestSerialPort()` does that
 * and then offers the chosen port to every family (a preferred one first),
 * so whichever "Connect…" button was pressed, the device ends up where it
 * belongs — the OS port names change too often to make the user pick.
 */

export interface SerialFamily {
	id: string
	/** Human name for messages ("LED Wall", "FluidNC"). */
	label: string
	/** Whether this family still has a device to find. */
	wants(): boolean
	/**
	 * Try to identify `port` as one of this family's devices. Must close the
	 * port and return false when it isn't; return true after adopting it (the
	 * family then owns the port until it calls `releaseSerialPort`).
	 */
	probe(port: SerialPort): Promise<SerialProbeResult>
	/**
	 * Name of the device this family has open on `port` right now ("LED Wall",
	 * "Box Rig"), or null when it holds nothing there. The ownership table is
	 * checked against this, so a record that outlived its connection can never
	 * block a port.
	 */
	holder(port: SerialPort): string | null
}

/**
 * A probe's third answer: a device of this family is on the port, but which
 * one can't be told right now (a held CNC controller answers real-time
 * characters only). The port is closed again, as for false, but the family is
 * not counted as having rejected it — the next discovery run asks again — and
 * the port is not offered to the remaining families. `undecided` is the
 * sentence to show.
 */
export interface SerialProbeUndecided {
	undecided: string
}

export type SerialProbeResult = boolean | SerialProbeUndecided

export type SerialRequestResult =
	/** The picker was dismissed. */
	| {status: 'cancelled'}
	/** Already open as `holder`, a device of `family`. */
	| {status: 'owned'; family: SerialFamily; holder: string; port: SerialPort}
	/** Adopted by `family` — the preferred one, or another that recognised it. */
	| {status: 'adopted'; family: SerialFamily; port: SerialPort}
	/**
	 * Nobody recognised the device on that port. `stuck`: the port itself
	 * never finished opening / closing, so nothing could be asked. `reason`: a
	 * family knows the device but could not identify it (`SerialProbeUndecided`).
	 */
	| {status: 'rejected'; port: SerialPort; stuck: boolean; reason?: string}

/** The sentence to show for a pick that connected nothing new. */
export function serialRequestError(
	result: Extract<SerialRequestResult, {status: 'owned' | 'rejected'}>
): string {
	const port = describeSerialPort(result.port)
	if (result.status === 'owned') {
		return `That port (${port}) is already connected as ${result.holder}`
	}
	if (result.reason) return `${result.reason} (${port})`
	return result.stuck
		? `That port (${port}) did not respond to the browser — replug its USB cable`
		: `No known device answered on that port (${port})`
}

const families = new Map<string, SerialFamily>()
const owners = new Map<SerialPort, string>()
const rejections = new WeakMap<SerialPort, Set<string>>()

let running: Promise<void> | null = null
let rerun = false

export function registerSerialFamily(family: SerialFamily) {
	families.set(family.id, family)
}

export function getSerialFamily(id: string): SerialFamily | undefined {
	return families.get(id)
}

export function claimSerialPort(port: SerialPort, familyId: string) {
	owners.set(port, familyId)
}

export function releaseSerialPort(port: SerialPort) {
	owners.delete(port)
}

export function serialPortOwner(port: SerialPort): string | undefined {
	return liveOwner(port)?.family.id
}

/**
 * Who has `port` open, verified against the family itself. A record whose
 * family no longer holds the port is dropped.
 */
function liveOwner(
	port: SerialPort
): {family: SerialFamily; holder: string} | null {
	const id = owners.get(port)
	if (id === undefined) return null
	const family = families.get(id)
	const holder = family?.holder(port) ?? null
	if (!family || holder === null) {
		owners.delete(port)
		return null
	}
	return {family, holder}
}

const USB_SERIAL_CHIPS: Record<number, string> = {
	0x10c4: 'CP210x',
	0x1a86: 'CH34x',
	0x0403: 'FTDI',
	0x303a: 'ESP32 USB',
}

/**
 * What the OS knows about a port: the USB-serial chip and vendor:product id
 * ("CP210x 10c4:ea60"). Enough to tell which board a message is about when
 * the picker's port names are not.
 */
export function describeSerialPort(port: SerialPort): string {
	const {usbVendorId, usbProductId} = port.getInfo()
	if (usbVendorId === undefined) return 'non-USB port'
	const hex = (n: number | undefined) =>
		(n ?? 0).toString(16).padStart(4, '0')
	const id = `${hex(usbVendorId)}:${hex(usbProductId)}`
	const chip = USB_SERIAL_CHIPS[usbVendorId]
	return chip ? `${chip} ${id}` : `USB ${id}`
}

/** Forget which ports a family rejected (e.g. after its match rule changed). */
export function resetRejections(familyId?: string) {
	// WeakMap can't be iterated; swap it for a fresh one when clearing all.
	if (familyId === undefined) {
		rejectionsRef.current = new WeakMap()
		return
	}
	rejectedAll.forEach(set => set.delete(familyId))
}

// Keep strong refs to the sets so a per-family reset can reach them.
const rejectedAll = new Set<Set<string>>()
const rejectionsRef = {current: rejections}

function rejectedBy(port: SerialPort): Set<string> {
	let set = rejectionsRef.current.get(port)
	if (!set) {
		set = new Set()
		rejectionsRef.current.set(port, set)
		rejectedAll.add(set)
	}
	return set
}

/**
 * Offer every granted, unowned port to every family that still wants one.
 * Coalesces concurrent calls; a call made while a run is in progress schedules
 * one more run after it.
 */
export function discoverSerialPorts(): Promise<void> {
	if (running) {
		rerun = true
		return running
	}
	running = (async () => {
		do {
			rerun = false
			await discoverOnce()
		} while (rerun)
	})().finally(() => {
		running = null
	})
	return running
}

async function discoverOnce() {
	if (typeof navigator === 'undefined' || !('serial' in navigator)) return
	let ports: SerialPort[]
	try {
		ports = await navigator.serial.getPorts()
	} catch {
		return
	}
	for (const port of ports) {
		if (liveOwner(port)) continue
		await offerPort(port, [...families.values()], true)
	}
}

/**
 * Longest a single probe may take. The slowest honest one is FluidNC on a
 * board that port-open just reset (boot wait + `$I`), well under this.
 */
const PROBE_TIMEOUT = 12000

/**
 * Run one probe, giving up after `PROBE_TIMEOUT`. `port.open()` / `close()`
 * have no timeout of their own and can stay pending for good on a board that
 * is half powered or re-enumerating; without the cap one such port would hold
 * up every later connection attempt ("Connecting…" forever).
 */
async function runProbe(
	family: SerialFamily,
	port: SerialPort
): Promise<ProbeOutcome> {
	const probing = family.probe(port).catch((): SerialProbeResult => false)
	// A probe that outlives the cap may still adopt the port: record it then.
	void probing.then(answer => {
		if (answer === true) owners.set(port, family.id)
	})
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<'stuck'>(resolve => {
		timer = setTimeout(() => resolve('stuck'), PROBE_TIMEOUT)
	})
	const result = await Promise.race<ProbeOutcome>([
		probing.then(answer =>
			answer === true ? 'adopted' : answer === false ? 'rejected' : answer
		),
		timeout,
	])
	clearTimeout(timer)
	return result
}

type ProbeOutcome = 'adopted' | 'rejected' | 'stuck' | SerialProbeUndecided

/**
 * Offer `port` to `candidates` in order until one adopts it. With
 * `respectRejections`, families that already turned this port down are
 * skipped (background discovery); a manual pick always re-probes. `stuck`
 * tells that a probe never came back, so the port itself is not answering
 * the browser — no point offering it to the remaining families. `reason`: a
 * family knows the device but can't identify it yet; the others aren't asked
 * either, and nothing is remembered against the port.
 */
async function offerPort(
	port: SerialPort,
	candidates: SerialFamily[],
	respectRejections: boolean
): Promise<{family: SerialFamily | null; stuck: boolean; reason?: string}> {
	const rejected = rejectedBy(port)
	for (const family of candidates) {
		if (!family.wants()) continue
		if (respectRejections && rejected.has(family.id)) continue
		const result = await runProbe(family, port)
		if (result === 'adopted') {
			rejected.delete(family.id)
			return {family, stuck: false}
		}
		if (typeof result === 'object') {
			return {family: null, stuck: false, reason: result.undecided}
		}
		rejected.add(family.id)
		if (result === 'stuck') return {family: null, stuck: true}
	}
	return {family: null, stuck: false}
}

/**
 * Prompt the user for a port (user gesture required) and identify what is on
 * it: `preferred` (the family whose button was pressed) probes first, then
 * every other family that still wants a device. A port a family has open is
 * reported without probing.
 */
export async function requestSerialPort(
	preferred?: SerialFamily,
	options?: SerialPortRequestOptions
): Promise<SerialRequestResult> {
	let port: SerialPort
	try {
		port = await navigator.serial.requestPort(options)
	} catch {
		return {status: 'cancelled'}
	}
	const owner = liveOwner(port)
	if (owner) return {status: 'owned', ...owner, port}

	// Wait for any background discovery so we don't race it on this port. If
	// that run identified the port meanwhile, the device is where it belongs.
	if (running) {
		await running.catch(() => {})
		const found = liveOwner(port)
		if (found) return {status: 'adopted', family: found.family, port}
	}

	const candidates = [
		...(preferred ? [preferred] : []),
		...[...families.values()].filter(f => f.id !== preferred?.id),
	]
	const {family, stuck, reason} = await offerPort(port, candidates, false)
	return family
		? {status: 'adopted', family, port}
		: {status: 'rejected', port, stuck, reason}
}

if (typeof navigator !== 'undefined' && 'serial' in navigator) {
	navigator.serial.addEventListener('connect', () => {
		void discoverSerialPorts()
	})
}
