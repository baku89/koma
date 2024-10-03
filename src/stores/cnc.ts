import {isEqual} from 'lodash-es'
import {defineStore} from 'pinia'
import {useTweeq} from 'tweeq'
import {computed, ref, watch, watchEffect} from 'vue'

export const useCncStore = defineStore('cnc', () => {
	const Tq = useTweeq()

	const port = ref<SerialPort | undefined>()

	const connected = computed(() => port.value !== null)

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

	watch(
		port,
		async (port, oldPort) => {
			if (oldPort) {
				oldPort.close()
			}
			if (port) {
				receive()
			}
		},
		{immediate: true}
	)

	const decoder = new TextDecoder()
	const encoder = new TextEncoder()

	const log = ref('')

	async function receive() {
		const p = port.value

		if (!p) return

		console.log('connected to CNC', p.getInfo())

		await p.open({baudRate: 115200})

		const reader = p.readable?.getReader()
		if (!reader) {
			console.info('cannot read from CNC', port.value?.getInfo())
			port.value = undefined
			return
		}

		try {
			while (p.readable) {
				const {value, done} = await reader.read()
				if (done) break

				log.value += decoder.decode(value)
			}
		} finally {
			reader.releaseLock()
		}
	}

	async function send(gcode: string) {
		const writer = port.value?.writable?.getWriter()
		if (!writer) {
			return
		}

		try {
			await writer.write(encoder.encode(gcode))
			log.value += `> ${gcode}\n`
		} finally {
			writer.releaseLock()
		}
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
					perform: () => send('$$\n'),
				},
				{
					id: 'send-gcode',
					label: 'Send G-Code',
					perform: () => {
						const gcode = prompt('G-code', '')
						if (gcode) send(gcode + '\n')
					},
				},
			],
		},
	])

	return {
		connect,
		connected,
		send,
		log,
	}
})
