/**
 * OSC bridge: koma talks OSC over a WebSocket (src/stores/osc.ts connects to
 * ws://localhost:8080); UDP on the other side for TouchDesigner, Max and the
 * like (in 5200 / out 5201). osc-js's BridgePlugin does the forwarding.
 */
import OSC from 'osc-js'

export function startOscBridge({wsPort = 8080, udpIn = 5200, udpOut = 5201, onMessage, onStatus} = {}) {
	const status = {state: 'off', wsPort, udpIn, udpOut, error: null, messages: 0, last: null}
	const osc = new OSC({
		plugin: new OSC.BridgePlugin({
			udpClient: {port: udpOut},
			udpServer: {port: udpIn},
			wsServer: {port: wsPort},
		}),
	})
	osc.on('open', () => {
		status.state = 'open'
		status.error = null
		onStatus?.(status)
	})
	osc.on('error', err => {
		status.state = 'error'
		status.error = err instanceof Error ? err.message : String(err)
		onStatus?.(status)
	})
	osc.on('*', e => {
		if (!(e instanceof OSC.Message)) return
		status.messages += 1
		status.last = {address: e.address, args: e.args, at: Date.now()}
		onMessage?.(status.last)
	})
	osc.open()
	return {
		status,
		osc,
		stop() {
			try {
				osc.close()
			} catch {
				// Already closed.
			}
			status.state = 'off'
		},
	}
}
