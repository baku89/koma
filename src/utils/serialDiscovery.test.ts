import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import type {SerialFamily} from './serialDiscovery'

type Discovery = typeof import('./serialDiscovery')

function fakePort(usbVendorId?: number, usbProductId?: number) {
	return {getInfo: () => ({usbVendorId, usbProductId})} as unknown as SerialPort
}

/** A family that recognises exactly the ports in `devices`. */
function fakeFamily(id: string, label: string, devices: SerialPort[]) {
	const held = new Set<SerialPort>()
	const family: SerialFamily = {
		id,
		label,
		wants: () => true,
		probe: async port => {
			if (!devices.includes(port)) return false
			held.add(port)
			return true
		},
		holder: port => (held.has(port) ? label : null),
	}
	return {family, held}
}

describe('serialDiscovery', () => {
	let discovery: Discovery
	let granted: SerialPort[]
	let picked: SerialPort

	beforeEach(async () => {
		vi.resetModules()
		granted = []
		vi.stubGlobal('navigator', {
			serial: {
				getPorts: async () => granted,
				requestPort: async () => picked,
				addEventListener: () => {},
			},
		})
		discovery = await import('./serialDiscovery')
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	it('hands a picked port to the family that recognises it', async () => {
		const led = fakePort(0x10c4, 0xea60)
		const rig = fakePort(0x1a86, 0x7523)
		const leds = fakeFamily('led', 'LED Wall', [led])
		const cnc = fakeFamily('cnc', 'Box Rig', [rig])
		discovery.registerSerialFamily(leds.family)
		discovery.registerSerialFamily(cnc.family)

		picked = led
		const result = await discovery.requestSerialPort(cnc.family)
		expect(result).toMatchObject({status: 'adopted', family: leds.family})
	})

	it('names the device that has the picked port open', async () => {
		const led = fakePort(0x10c4, 0xea60)
		const leds = fakeFamily('led', 'LED Wall', [led])
		const cnc = fakeFamily('cnc', 'Box Rig', [])
		discovery.registerSerialFamily(leds.family)
		discovery.registerSerialFamily(cnc.family)

		picked = led
		await discovery.requestSerialPort(leds.family)
		const result = await discovery.requestSerialPort(cnc.family)
		expect(result).toMatchObject({status: 'owned', holder: 'LED Wall'})
		if (result.status !== 'owned') throw new Error('unreachable')
		expect(discovery.serialRequestError(result)).toBe(
			'That port (CP210x 10c4:ea60) is already connected as LED Wall'
		)
	})

	it('drops an ownership record the family no longer backs', async () => {
		const port = fakePort(0x1a86, 0x7523)
		const leds = fakeFamily('led', 'LED Wall', [port])
		discovery.registerSerialFamily(leds.family)

		picked = port
		await discovery.requestSerialPort(leds.family)
		// The connection went away without `releaseSerialPort`.
		leds.held.clear()

		expect(discovery.serialPortOwner(port)).toBeUndefined()
		const again = await discovery.requestSerialPort(leds.family)
		expect(again.status).toBe('adopted')
	})

	it('reports a port adopted by a background run as adopted, not owned', async () => {
		const rig = fakePort(0x1a86, 0x7523)
		const cnc = fakeFamily('cnc', 'Box Rig', [rig])
		discovery.registerSerialFamily(cnc.family)

		granted = [rig]
		picked = rig
		const background = discovery.discoverSerialPorts()
		const result = await discovery.requestSerialPort(cnc.family)
		await background
		expect(result.status).toBe('adopted')
	})

	it('keeps asking about a device its family could not identify', async () => {
		const port = fakePort(0x10c4, 0xea60)
		let held = true
		const cnc = fakeFamily('cnc', 'FluidNC', [port])
		const identify = cnc.family.probe
		const cncProbe = vi.fn(async (p: SerialPort) =>
			held ? {undecided: 'The controller on that port is in Hold'} : identify(p)
		)
		cnc.family.probe = cncProbe
		const leds = fakeFamily('led', 'LED Wall', [])
		const ledProbe = vi.spyOn(leds.family, 'probe')
		discovery.registerSerialFamily(cnc.family)
		discovery.registerSerialFamily(leds.family)

		picked = port
		const result = await discovery.requestSerialPort(leds.family)
		expect(result).toMatchObject({status: 'rejected', stuck: false})
		if (result.status !== 'rejected') throw new Error('unreachable')
		expect(discovery.serialRequestError(result)).toBe(
			'The controller on that port is in Hold (CP210x 10c4:ea60)'
		)

		// It is a CNC controller: background discovery doesn't try it as an LED
		// driver, and asks the CNC family again on every run.
		ledProbe.mockClear()
		granted = [port]
		await discovery.discoverSerialPorts()
		await discovery.discoverSerialPorts()
		expect(cncProbe).toHaveBeenCalledTimes(3)
		expect(ledProbe).not.toHaveBeenCalled()

		held = false
		await discovery.discoverSerialPorts()
		expect(discovery.serialPortOwner(port)).toBe('cnc')
	})

	it('offers a dropped port to its family again, as often as asked', async () => {
		const led = fakePort(0x10c4, 0xea60)
		const other = fakePort(0x10c4, 0xea60)
		granted = [led, other]
		let powered = false
		let probes: SerialPort[] = []
		let held = false
		const family: SerialFamily = {
			id: 'led',
			label: 'LED Wall',
			wants: () => !held,
			probe: async port => {
				probes.push(port)
				if (port !== led || !powered) return false
				held = true
				return true
			},
			holder: port => (held && port === led ? 'LED Wall' : null),
		}
		discovery.registerSerialFamily(family)

		// Discovery asks once and remembers the rejection…
		await discovery.discoverSerialPorts()
		await discovery.discoverSerialPorts()
		expect(probes).toEqual([led, other])

		// …the family itself may keep asking about its own port.
		probes = []
		expect(await discovery.reofferSerialPort(family, led)).toBe(false)
		powered = true
		expect(await discovery.reofferSerialPort(family, led)).toBe(true)
		expect(probes).toEqual([led, led])
		expect(discovery.serialPortOwner(led)).toBe('led')

		// Already there: nothing is opened.
		expect(await discovery.reofferSerialPort(family, led)).toBe(true)
		expect(probes).toHaveLength(2)
	})

	it('labels a connected port by its place in the granted list', async () => {
		const usb = (vendor: number) =>
			({getInfo: () => ({usbVendorId: vendor, usbProductId: 0xea60})}) as SerialPort
		const a = usb(0x10c4)
		const b = usb(0x10c4)
		// Nothing listed yet: only what the OS knows.
		expect(discovery.serialPortLabel(b)).toBe('CP210x 10c4:ea60')
		granted = [a, b]
		await discovery.discoverSerialPorts()
		expect(discovery.serialPortLabel(a)).toBe('#1 · CP210x 10c4:ea60')
		expect(discovery.serialPortLabel(b)).toBe('#2 · CP210x 10c4:ea60')
		// A port granted since (requestPort) joins the list.
		const c = usb(0x1a86)
		granted = [a, b, c]
		picked = c
		await discovery.requestSerialPort()
		expect(discovery.serialPortLabel(c)).toBe('#3 · CH34x 1a86:ea60')
	})

	it('gives up on a probe that never returns', async () => {
		vi.useFakeTimers()
		const port = fakePort(0x1a86, 0x7523)
		const stuck: SerialFamily = {
			id: 'cnc',
			label: 'FluidNC',
			wants: () => true,
			probe: () => new Promise<boolean>(() => {}),
			holder: () => null,
		}
		const leds = fakeFamily('led', 'LED Wall', [port])
		const ledProbe = vi.spyOn(leds.family, 'probe')
		discovery.registerSerialFamily(stuck)
		discovery.registerSerialFamily(leds.family)

		picked = port
		const pending = discovery.requestSerialPort(stuck)
		await vi.advanceTimersByTimeAsync(60_000)
		const result = await pending
		expect(result).toMatchObject({status: 'rejected', stuck: true})
		// The port is not answering the browser: no point asking the next family.
		expect(ledProbe).not.toHaveBeenCalled()
		if (result.status !== 'rejected') throw new Error('unreachable')
		expect(discovery.serialRequestError(result)).toContain('CH34x 1a86:7523')

		// Background discovery is not blocked by it either.
		granted = [port]
		const run = discovery.discoverSerialPorts()
		await vi.advanceTimersByTimeAsync(60_000)
		await run
	})
})
