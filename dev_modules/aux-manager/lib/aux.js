/**
 * Koma's local helper, as a library: `yarn aux` / `yarn dev` wrap it in a
 * terminal UI (../index.js), the desktop app runs it inside Electron's main
 * process (electron/aux.ts). No output of its own — it reports through
 * `on('log')` and `on('status')`.
 *
 * - ptpcamera killer (macOS), see ptpcamera.js
 * - OSC bridge ws :8080 ↔ udp 5200 / 5201, see osc.js
 * - tools bridge: the MCP server koma plugs into, see toolsBridge.js
 */
import {startOscBridge} from './osc.js'
import {startPtpKiller} from './ptpcamera.js'
import {startToolsBridge, TOOLS_PORT} from './toolsBridge.js'

export {TOOLS_PORT}

const HISTORY = 500

export function createAux({ptp = {}, osc = {}, tools = {}, version = '0.0.0'} = {}) {
	const listeners = {log: new Set(), status: new Set()}
	const emit = (event, payload) => {
		for (const fn of listeners[event]) fn(payload)
	}
	/** The last lines, for a display that attaches after startup. */
	const history = []
	const log = (tag, text, level = 'info') => {
		const entry = {t: Date.now(), tag, text, level}
		history.push(entry)
		if (history.length > HISTORY) history.shift()
		emit('log', entry)
	}
	const status = {ptp: null, osc: null, tools: null}
	const changed = () => emit('status', status)

	const killer = startPtpKiller({...ptp, onKill: changed})
	status.ptp = killer.status
	if (!killer.status.active) log('ptp', 'not macOS — ptpcamera killer idle')

	const bridge = startOscBridge({
		...osc,
		onStatus: s => {
			if (s.state === 'error') log('osc', s.error, 'error')
			else if (s.state === 'open') log('osc', `ws :${s.wsPort} ↔ udp in ${s.udpIn} / out ${s.udpOut}`)
			changed()
		},
		onMessage: m => {
			log('osc', `${m.address} ${m.args.map(fmtArg).join(' ')}`)
			changed()
		},
	})
	status.osc = bridge.status

	const toolsBridge = startToolsBridge({...tools, version, log, onStatus: changed})
	status.tools = toolsBridge.status

	return {
		status,
		history,
		tools: toolsBridge,
		osc: bridge,
		on(event, fn) {
			listeners[event].add(fn)
			return () => listeners[event].delete(fn)
		},
		log,
		stop() {
			killer.stop()
			bridge.stop()
			toolsBridge.stop()
		},
	}
}

function fmtArg(v) {
	return typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : JSON.stringify(v)
}
