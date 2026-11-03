/**
 * The aux helper, in-process (what `yarn aux` / `yarn dev` run from a
 * terminal, see dev_modules/aux-manager): the ptpcamera killer, the OSC
 * bridge (ws :8080 ↔ udp 5200 / 5201) and the tools bridge — the MCP server
 * Claude Code and scripts reach the open project through (:8090). The
 * library reports through events; here they go to the console and to the
 * renderer's `window.koma.auxStatus()`.
 *
 * If a `yarn dev` / `yarn aux` is already running, its ports are taken: the
 * library reports that and gives up on those, and the renderer simply
 * connects to the other process's bridges instead.
 */
import {type Aux, type AuxStatus, createAux} from '../dev_modules/aux-manager/lib/aux.js'

export type {AuxStatus}

let aux: Aux | null = null

export function startAux(version: string) {
	if (aux) return aux
	aux = createAux({version})
	aux.on('log', e => {
		const line = `[aux:${e.tag}] ${e.text}`
		// eslint-disable-next-line no-console
		if (e.level === 'error') console.error(line)
		// eslint-disable-next-line no-console
		else if (e.level === 'warn') console.warn(line)
		// eslint-disable-next-line no-console
		else if (e.tag !== 'osc') console.log(line)
	})
	return aux
}

export function stopAux() {
	aux?.stop()
	aux = null
}

export function auxStatus(): AuxStatus | null {
	return aux ? JSON.parse(JSON.stringify(aux.status)) : null
}
