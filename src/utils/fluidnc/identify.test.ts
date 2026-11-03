import {describe, expect, it} from 'vitest'

import {identifyController, likelyOwner} from './identify'

/** Answers `?` with `state`; `onLine` answers the lines. */
function fakePort(state: string, onLine: (line: string, say: (s: string) => void) => void) {
	let push: (b: Uint8Array) => void = () => {}
	const enc = new TextEncoder()
	const say = (s: string) => push(enc.encode(s + '\r\n'))
	let readable: ReadableStream<Uint8Array> | null = null
	let writable: WritableStream<Uint8Array> | null = null
	return {
		get readable() {
			return readable
		},
		get writable() {
			return writable
		},
		async open() {
			readable = new ReadableStream({
				start(c) {
					push = b => c.enqueue(b)
				},
			})
			writable = new WritableStream({
				write(bytes) {
					if (bytes.length === 1 && bytes[0] === 0x3f) {
						say(`<${state}|MPos:0,0,0|FS:0,0>`)
						return
					}
					onLine(new TextDecoder().decode(bytes).trim(), say)
				},
			})
		},
		async close() {},
		addEventListener() {},
		removeEventListener() {},
		getInfo: () => ({usbVendorId: 0x10c4, usbProductId: 0xea60}),
	} as unknown as SerialPort
}

const NAME = ['[VER:3.9 FluidNC v3.9.9:]', '[MSG: Machine: BoxRig]', 'ok']
const options = {statusInterval: 0, identifyTimeout: 100}

describe('identifyController', () => {
	it('asks again when a boot banner fails the $I of a controller in Alarm', async () => {
		let asked = 0
		const port = fakePort('Alarm', (_, say) => {
			if (asked++ === 0) say("Grbl 3.9 [FluidNC v3.9.9 '$' for help]")
			else NAME.forEach(say)
		})
		const {client, info} = await identifyController(port, options)
		expect(asked).toBe(2)
		expect(info?.machineName).toBe('BoxRig')
		await client.close()
	})

	it('asks again after an ALARM line and after an empty answer', async () => {
		const answers = ['ALARM:1', 'ok']
		const port = fakePort('Alarm', (_, say) => {
			const a = answers.shift()
			if (a) say(a)
			else NAME.forEach(say)
		})
		const {client, info} = await identifyController(port, options)
		expect(info?.machineName).toBe('BoxRig')
		await client.close()
	})

	it('takes silence in Alarm as a critical alarm, and keeps the port', async () => {
		const port = fakePort('Alarm', () => {})
		const {client, info} = await identifyController(port, options)
		expect(info).toBeNull()
		expect(client.isOpen).toBe(true)
		await client.close()
	})

	it('gives up on silence from a controller that is not in Alarm', async () => {
		const port = fakePort('Idle', () => {})
		await expect(identifyController(port, options)).rejects.toThrow(/No "ok"/)
	})

	it("doesn't ask a held controller", async () => {
		let asked = 0
		const port = fakePort('Hold', () => asked++)
		const {client, info} = await identifyController(port, options)
		expect(info).toBeNull()
		expect(asked).toBe(0)
		await client.close()
	})
})

describe('likelyOwner', () => {
	const m = (lastPort: string) => ({lastPortId: () => lastPort})
	const rig = m('4292:60000')
	const mill = m('6790:29987')
	const fresh = m('')

	it('picks the only machine last seen on this chip', () => {
		expect(likelyOwner([rig, mill], '4292:60000')).toBe(rig)
		expect(likelyOwner([rig, mill], '6790:29987')).toBe(mill)
	})
	it('picks the only machine left', () => {
		expect(likelyOwner([fresh], '4292:60000')).toBe(fresh)
		expect(likelyOwner([mill], '4292:60000')).toBe(mill)
	})
	it("won't guess between machines", () => {
		expect(likelyOwner([rig, m('4292:60000')], '4292:60000')).toBeNull()
		expect(likelyOwner([fresh, m('')], '4292:60000')).toBeNull()
		expect(likelyOwner([rig, mill], '')).toBeNull()
	})
})
