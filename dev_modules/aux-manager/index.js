#!/usr/bin/env node
/**
 * `yarn aux` / `yarn dev`: koma's local helper with a terminal UI.
 *
 *   node index.js            ptpcamera killer + OSC bridge + MCP tools bridge
 *   node index.js --vite     …plus koma's Vite dev server, in this process
 *   --port <n>               Vite port (default from vite.config.ts, 5555)
 *   --tools-port <n>         MCP / tools bridge port (default 8090)
 *   --plain                  one line per event instead of the UI
 *
 * The desktop app (yarn app) runs the same library inside Electron and does
 * not need this; running both at once just makes the second one report the
 * ports as taken.
 */
import {readFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {createAux} from './lib/aux.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? '0.0.0'

const args = process.argv.slice(2)
const flag = name => args.includes(`--${name}`)
const value = name => {
	const i = args.indexOf(`--${name}`)
	return i >= 0 ? args[i + 1] : undefined
}
if (flag('help') || flag('h')) {
	// eslint-disable-next-line no-console
	console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*\n|^ \* ?/gm, ''))
	process.exit(0)
}
const withVite = flag('vite') && !flag('no-vite')
const plain = flag('plain') || !process.stdout.isTTY
const toolsPort = value('tools-port') ? Number(value('tools-port')) : undefined

const aux = createAux({version, tools: toolsPort ? {port: toolsPort} : {}})

//------------------------------------------------------------------------------
// Vite, in-process: its logger feeds the UI, its URL goes in the status block.

async function startVite() {
	const listeners = new Set()
	const status = {state: 'starting', url: null, error: null}
	const changed = () => listeners.forEach(fn => fn(status))
	const vite = {status, on: fn => (listeners.add(fn), () => listeners.delete(fn)), server: null}
	const strip = s => String(s).replace(/\u001b\[[0-9;]*m/g, '').trim()
	const log = (level, msg) => {
		for (const line of strip(msg).split('\n')) if (line) aux.log('vite', line, level)
	}
	const warned = new Set()
	const customLogger = {
		hasWarned: false,
		info: m => log('info', m),
		warn: m => log('warn', m),
		warnOnce: m => {
			if (warned.has(m)) return
			warned.add(m)
			log('warn', m)
		},
		error: m => log('error', m),
		clearScreen() {},
		hasErrorLogged: () => false,
	}
	try {
		const {createServer} = await import('vite')
		const port = value('port') ? Number(value('port')) : undefined
		const server = await createServer({
			configFile: path.join(root, 'vite.config.ts'),
			root,
			clearScreen: false,
			customLogger,
			server: port ? {port} : {},
		})
		await server.listen()
		vite.server = server
		status.url = server.resolvedUrls?.local[0] ?? `http://localhost:${server.config.server.port}/`
		status.state = 'ready'
		aux.log('vite', `dev server at ${status.url}`)
	} catch (e) {
		status.state = 'error'
		status.error = e instanceof Error ? e.message : String(e)
		aux.log('vite', status.error, 'error')
	}
	changed()
	return vite
}

const vite = withVite ? await startVite() : null

//------------------------------------------------------------------------------
// UI and shutdown

let quitting = false
async function quit(code = 0) {
	if (quitting) return
	quitting = true
	aux.stop()
	await vite?.server?.close().catch(() => {})
	process.exit(code)
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => void quit(0))
process.on('uncaughtException', e => {
	aux.log('aux', `uncaught: ${e?.stack ?? e}`, 'error')
})
process.on('unhandledRejection', e => {
	aux.log('aux', `unhandled: ${e instanceof Error ? e.stack : e}`, 'error')
})

const ui = await import('./ui.js')
if (plain) ui.renderPlain({aux, vite, version})
else ui.renderUi({aux, vite, version, onQuit: () => void quit(0)})
