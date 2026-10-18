/**
 * The aux helper, in-process (what `yarn aux` / dev_modules/aux-manager does
 * from a terminal):
 *
 * - macOS: keep `ptpcamera` from claiming the camera's PTP interface. It is
 *   spawned by the system whenever a PTP device appears and holds the
 *   interface, so WebUSB's claimInterface fails ("Unable to claim interface").
 *   There is no API to detach it; it gets killed on a short interval.
 * - OSC bridge: WebSocket :8080 ↔ UDP (in 5200 / out 5201), for koma's
 *   `/shoot` and the like (`src/stores/osc.ts` connects to localhost:8080).
 *   If something else already listens there (a `yarn aux` still running), the
 *   bridge just reports the error and the renderer keeps retrying as usual.
 */
import {exec} from 'node:child_process'

import OSC from 'osc-js'

const PTP_KILL_INTERVAL_MS = 250
const OSC_WS_PORT = 8080
const OSC_UDP_IN = 5200
const OSC_UDP_OUT = 5201

export interface AuxStatus {
	ptpKiller: boolean
	osc: 'off' | 'open' | 'error'
	oscError?: string
}

const status: AuxStatus = {ptpKiller: false, osc: 'off'}

function startPtpKiller() {
	if (process.platform !== 'darwin') return
	status.ptpKiller = true
	const tick = () => {
		// pkill exits 1 when there is nothing to kill — not an error for us.
		exec('pkill -9 -x ptpcamera', () => setTimeout(tick, PTP_KILL_INTERVAL_MS))
	}
	tick()
}

function startOscBridge() {
	const osc = new OSC({
		plugin: new OSC.BridgePlugin({
			udpClient: {port: OSC_UDP_OUT},
			udpServer: {port: OSC_UDP_IN},
			wsServer: {port: OSC_WS_PORT},
		}),
	})
	osc.on('open', () => {
		status.osc = 'open'
		status.oscError = undefined
	})
	osc.on('error', (err: unknown) => {
		status.osc = 'error'
		status.oscError = err instanceof Error ? err.message : String(err)
		// eslint-disable-next-line no-console
		console.warn('[aux] OSC bridge:', status.oscError)
	})
	osc.open()
}

export function startAux() {
	startPtpKiller()
	startOscBridge()
}

export function auxStatus(): AuxStatus {
	return {...status}
}
