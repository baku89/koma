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
 * still needs `requestPort()` from a click.
 */

export interface SerialFamily {
	id: string
	/** Whether this family still has a device to find. */
	wants(): boolean
	/**
	 * Try to identify `port` as one of this family's devices. Must close the
	 * port and return false when it isn't; return true after adopting it (the
	 * family then owns the port until it calls `releaseSerialPort`).
	 */
	probe(port: SerialPort): Promise<boolean>
}

const families = new Map<string, SerialFamily>()
const owners = new Map<SerialPort, string>()
const rejections = new WeakMap<SerialPort, Set<string>>()

let running: Promise<void> | null = null
let rerun = false

export function registerSerialFamily(family: SerialFamily) {
	families.set(family.id, family)
}

export function claimSerialPort(port: SerialPort, familyId: string) {
	owners.set(port, familyId)
}

export function releaseSerialPort(port: SerialPort) {
	owners.delete(port)
}

export function serialPortOwner(port: SerialPort): string | undefined {
	return owners.get(port)
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
		if (owners.has(port)) continue
		const rejected = rejectedBy(port)
		for (const family of families.values()) {
			if (!family.wants() || rejected.has(family.id)) continue
			let adopted = false
			try {
				adopted = await family.probe(port)
			} catch {
				adopted = false
			}
			if (adopted) {
				owners.set(port, family.id)
				break
			}
			rejected.add(family.id)
		}
	}
}

/**
 * Prompt the user for a port (user gesture required) and offer it to one
 * family. Returns whether it was adopted. A port already owned by another
 * family is refused without probing.
 */
export async function requestSerialPortFor(
	family: SerialFamily,
	options?: SerialPortRequestOptions
): Promise<'adopted' | 'rejected' | 'cancelled' | 'owned'> {
	let port: SerialPort
	try {
		port = await navigator.serial.requestPort(options)
	} catch {
		return 'cancelled'
	}
	const owner = owners.get(port)
	if (owner && owner !== family.id) return 'owned'
	if (owner === family.id) return 'adopted'

	// Wait for any background discovery so we don't race it on this port.
	if (running) await running.catch(() => {})
	if (owners.has(port)) return 'owned'

	const adopted = await family.probe(port)
	if (adopted) {
		owners.set(port, family.id)
		rejectedBy(port).delete(family.id)
		return 'adopted'
	}
	return 'rejected'
}

if (typeof navigator !== 'undefined' && 'serial' in navigator) {
	navigator.serial.addEventListener('connect', () => {
		void discoverSerialPorts()
	})
}
