/**
 * Opening a port and asking the controller on it who it is (`$I`), which it
 * can't always answer. DOM-only through FluidNCClient; the choices are pure.
 */

import {FluidNCClient, type FluidNCClientOptions, FluidNCError} from './FluidNCClient'
import type {BuildInfo, MachineStatus} from './status'

/**
 * Feed hold / safety door: the controller still answers real-time characters
 * (`?`, `~`, Ctrl-X) but runs no line — `$I` included — until it is released.
 */
export function isSuspended(status: MachineStatus | null) {
	return status?.state === 'Hold' || status?.state === 'Door'
}

/**
 * In a *critical* alarm (hard / soft limit) FluidNC runs nothing but a reset
 * (Ctrl-X) and status reports until it is reset: `$I` goes unanswered. An
 * ordinary Alarm (unhomed, a failed homing) answers it. The two look the same
 * in the status report, so only silence tells them apart.
 */
export function inAlarm(status: MachineStatus | null) {
	return status?.state === 'Alarm'
}

const IDENTIFY_ATTEMPTS = 3
const IDENTIFY_RETRY_MS = 300

/**
 * `info` null: the controller can't be asked yet — suspended, or in a critical
 * alarm. Anything else that spoils an answer is asked again: a boot banner
 * failing the line in flight (the board reset as the port opened, and comes up
 * in an ordinary Alarm when it must home), an alarm or error line, a stray `ok`
 * answering with nothing. Only silence in Alarm counts as critical.
 */
export async function identifyController(
	port: SerialPort,
	options: FluidNCClientOptions & {identifyTimeout?: number} = {}
): Promise<{client: FluidNCClient; info: BuildInfo | null}> {
	const client = new FluidNCClient(port, options)
	await client.open()
	// Don't leave a `$I` waiting in a held controller: it would run after the
	// release, and its late `ok` would answer whatever line is in flight then.
	if (isSuspended(client.status)) return {client, info: null}
	let failure: unknown = new Error('The controller did not say who it is')
	for (let attempt = 0; attempt < IDENTIFY_ATTEMPTS; attempt++) {
		if (attempt > 0) await new Promise(resolve => setTimeout(resolve, IDENTIFY_RETRY_MS))
		if (!client.isOpen) break
		if (isSuspended(client.status)) return {client, info: null}
		try {
			const info = await client.getBuildInfo(options.identifyTimeout)
			if (info.version !== undefined || info.machineName !== undefined) {
				return {client, info}
			}
		} catch (e) {
			failure = e
			if (e instanceof FluidNCError && e.kind === 'timeout') {
				if (inAlarm(client.status) || isSuspended(client.status)) {
					return {client, info: null}
				}
				break
			}
		}
	}
	await client.close()
	throw failure
}

/** A USB bridge chip, as far as the browser can tell: `<vendor>:<product>`. */
export function serialPortId(port: SerialPort) {
	const {usbVendorId, usbProductId} = port.getInfo()
	return usbVendorId === undefined ? '' : `${usbVendorId}:${usbProductId}`
}

/**
 * Which machine a controller that can't say who it is most likely belongs to,
 * of those without a controller: the only one last seen on this kind of USB
 * chip, or else the only one left. Null when that doesn't settle it. A wrong
 * guess costs little: until `$I` confirms, such a machine takes real-time
 * commands only, and hands the port over if it turns out to be another one.
 */
export function likelyOwner<T extends {lastPortId: () => string}>(
	wanting: readonly T[],
	portId: string
): T | null {
	const sameChip = portId ? wanting.filter(m => m.lastPortId() === portId) : []
	if (sameChip.length > 0) return sameChip.length === 1 ? sameChip[0] : null
	return wanting.length === 1 ? wanting[0] : null
}
