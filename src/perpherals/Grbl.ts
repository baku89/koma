type State =
	| 'idle'
	| 'run'
	| 'hold'
	| 'door'
	| 'home'
	| 'alarm'
	| 'check'
	| 'sleep'

export class Grbl {
	#port: SerialPort
	#opened = false

	#reader: ReadableStreamDefaultReader<Uint8Array> | null = null
	#writer: WritableStreamDefaultWriter<Uint8Array> | null = null

	constructor(port: SerialPort) {
		this.#port = port
	}

	async open(baudRate = 115200) {
		try {
			await this.#port.open({baudRate})
			this.#reader = this.#port.readable?.getReader()
			this.#writer = this.#port.writable?.getWriter()
			this.#opened = true
		} catch (error) {
			this.#opened = false
			throw new Error(`Cannot open port: ${error}`)
		}

		// Auto-start the receiver
	}

	async close() {}
}
