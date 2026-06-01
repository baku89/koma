import {CNCDeviceWebSerialGrbl, type CNCStatus} from 'gcnc'
import {isEqual} from 'lodash-es'
import {defineStore} from 'pinia'
import {useTweeq} from 'tweeq'
import {computed, ref, shallowRef, watch, watchEffect} from 'vue'

export const useCncStore = defineStore('cnc', () => {
	const Tq = useTweeq()

	const port = shallowRef<SerialPort | undefined>()
	const device = shallowRef<CNCDeviceWebSerialGrbl | undefined>()

	const connected = ref(false)
	const status = ref<CNCStatus | undefined>()
	const log = ref('')

	const savedInfo = Tq.config.ref<SerialPortInfo | null>('cnc.info', null)

	const init = async () => {
		const ports = await navigator.serial.getPorts()
		port.value = ports.find(p => isEqual(p.getInfo(), savedInfo.value))
	}

	init()

	const connect = async () => {
		try {
			port.value = await navigator.serial.requestPort()
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
		} catch (e) {
			port.value = undefined
		}
	}

	// Save the port info
	watchEffect(() => {
		savedInfo.value = port.value?.getInfo() ?? null
	})

	// (Re)create the Grbl device whenever the port changes
	watch(
		port,
		async (port, oldPort) => {
			if (oldPort && device.value) {
				await device.value.close().catch(() => null)
			}

			device.value = undefined
			connected.value = false
			status.value = undefined

			if (!port) return

			const dev = new CNCDeviceWebSerialGrbl(port)

			dev.on('message', message => {
				log.value += message + '\n'
			})
			dev.on('status', s => {
				status.value = s
			})
			dev.on('connect', () => {
				connected.value = true
			})
			dev.on('disconnect', () => {
				connected.value = false
				device.value = undefined
			})

			try {
				await dev.open()
				device.value = dev
			} catch (e) {
				console.error('Failed to open CNC device', e)
				device.value = undefined
				connected.value = false
			}
		},
		{immediate: true}
	)

	/**
	 * Sends a single line of G-code and resolves with Grbl's response once it
	 * acknowledges the command with `ok` (i.e. when it is accepted into the
	 * planner buffer — NOT when the motion finishes). A trailing newline is
	 * added by the device layer, so callers should omit it.
	 */
	async function send(line: string): Promise<string | undefined> {
		if (!device.value) return undefined
		return device.value.send(line.replace(/\n+$/, ''))
	}

	// Actions

	const {actions} = useTweeq()

	actions.register([
		{
			id: 'motion-control',
			label: 'Motion Control',
			icon: 'game-icons:mechanical-arm',
			children: [
				{
					id: 'connect-cnc',
					label: 'Connect to CNC',
					perform: connect,
				},
				{
					id: 'get-status',
					label: 'Get CNC status',
					perform: () => send('$$'),
				},
				{
					id: 'send-gcode',
					label: 'Send G-Code',
					perform: () => {
						const gcode = prompt('G-code', '')
						if (gcode) send(gcode)
					},
				},
			],
		},
	])

	return {
		connect,
		connected: computed(() => connected.value),
		status: computed(() => status.value),
		send,
		log,
	}
})
