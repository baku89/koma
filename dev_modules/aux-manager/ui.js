/**
 * The terminal UI of `yarn aux` / `yarn dev` (Ink): a status block on top —
 * ptpcamera, OSC, MCP, Vite — and the log below it. Pure display: everything
 * comes from the aux library's `status` and `log` events (lib/aux.js).
 */
import {exec} from 'node:child_process'

import htm from 'htm'
import {Box, render, Text, useApp, useInput, useStdout} from 'ink'
import {createElement as h, useEffect, useState} from 'react'

const html = htm.bind(h)

const LOG_LIMIT = 500
const TAG_COLORS = {osc: 'magenta', mcp: 'cyan', tools: 'cyan', vite: 'green', ptp: 'yellow', aux: 'gray'}

function time(t) {
	return new Date(t).toLocaleTimeString('en-GB', {hour12: false})
}

function ago(t) {
	const s = Math.max(0, Math.round((Date.now() - t) / 1000))
	if (s < 60) return `${s}s ago`
	if (s < 3600) return `${Math.floor(s / 60)}m ago`
	return `${Math.floor(s / 3600)}h ago`
}

/** One row of the status block: a dot, a name, a sentence. */
function Row({state, name, children}) {
	const dot = {on: ['●', 'green'], off: ['○', 'gray'], error: ['✖', 'red'], busy: ['◐', 'yellow']}[state] ?? ['○', 'gray']
	return html`<${Box}>
		<${Text} color=${dot[1]}>${dot[0]} </${Text}>
		<${Text} bold>${name.padEnd(10)}</${Text}>
		<${Text}>${children}</${Text}>
	</${Box}>`
}

function PtpRow({ptp}) {
	if (!ptp?.active) return html`<${Row} state="off" name="ptpcamera">not macOS — nothing to kill</${Row}>`
	return html`<${Row} state="on" name="ptpcamera">${
		ptp.kills ? `killed ${ptp.kills}× · last ${ago(ptp.lastKillAt)}` : 'watching (250 ms)'
	}</${Row}>`
}

function OscRow({osc}) {
	if (!osc) return null
	if (osc.state === 'error') return html`<${Row} state="error" name="OSC"><${Text} color="red">${osc.error}</${Text}></${Row}>`
	const last = osc.last ? ` · last ${osc.last.address} ${ago(osc.last.at)}` : ''
	return html`<${Row} state=${osc.state === 'open' ? 'on' : 'busy'} name="OSC">${
		`ws :${osc.wsPort} ↔ udp in ${osc.udpIn} / out ${osc.udpOut}${osc.messages ? ` · ${osc.messages} msgs${last}` : ''}`
	}</${Row}>`
}

function McpRow({tools}) {
	if (!tools) return null
	if (tools.state === 'error') return html`<${Row} state="error" name="MCP"><${Text} color="red">${tools.error}</${Text}></${Row}>`
	if (tools.state !== 'listening') return html`<${Row} state="busy" name="MCP">starting…</${Row}>`
	const url = `http://${tools.host}:${tools.port}/mcp`
	const parts = [url]
	if (tools.provider) {
		parts.push(`koma${tools.provider.project ? ` "${tools.provider.project}"` : ''} · ${tools.tools} tools`)
	} else parts.push('waiting for koma')
	if (tools.sessions) parts.push(`${tools.sessions} client${tools.sessions === 1 ? '' : 's'}`)
	if (tools.lastCall) {
		parts.push(`${tools.calls} calls · last ${tools.lastCall.name} ${tools.lastCall.ok ? 'ok' : 'failed'}`)
	}
	return html`<${Row} state=${tools.provider ? 'on' : 'busy'} name="MCP">${parts.join(' · ')}</${Row}>`
}

function ViteRow({vite}) {
	if (!vite) return null
	if (vite.state === 'error') return html`<${Row} state="error" name="Vite"><${Text} color="red">${vite.error}</${Text}></${Row}>`
	if (vite.state !== 'ready') return html`<${Row} state="busy" name="Vite">starting…</${Row}>`
	return html`<${Row} state="on" name="Vite"><${Text} underline>${vite.url}</${Text}>  (o to open)</${Row}>`
}

function LogLine({entry, columns}) {
	const color = entry.level === 'error' ? 'red' : entry.level === 'warn' ? 'yellow' : undefined
	const tag = entry.tag.padEnd(5)
	const width = Math.max(10, columns - 15)
	const text = entry.text.length > width ? `${entry.text.slice(0, width - 1)}…` : entry.text
	return html`<${Box}>
		<${Text} dimColor>${time(entry.t)} </${Text}>
		<${Text} color=${TAG_COLORS[entry.tag] ?? 'white'}>${tag} </${Text}>
		<${Text} color=${color}>${text}</${Text}>
	</${Box}>`
}

function App({aux, vite, version, onOpen}) {
	const {exit} = useApp()
	const {stdout} = useStdout()
	const [size, setSize] = useState({rows: stdout.rows ?? 24, columns: stdout.columns ?? 80})
	const [tick, setTick] = useState(0)
	const [logs, setLogs] = useState(() => [...aux.history])

	useEffect(() => {
		// Batch bursts (an OSC slider at 60 Hz) into one render.
		let pending = []
		let timer = null
		const flush = () => {
			timer = null
			const add = pending
			pending = []
			setLogs(prev => [...prev, ...add].slice(-LOG_LIMIT))
		}
		const offLog = aux.on('log', entry => {
			pending.push(entry)
			if (!timer) timer = setTimeout(flush, 40)
		})
		let statusTimer = null
		const bump = () => {
			if (!statusTimer) statusTimer = setTimeout(() => {
				statusTimer = null
				setTick(t => t + 1)
			}, 100)
		}
		const offStatus = aux.on('status', bump)
		const offVite = vite?.on(bump)
		const clock = setInterval(bump, 5000)
		const onResize = () => setSize({rows: stdout.rows ?? 24, columns: stdout.columns ?? 80})
		stdout.on('resize', onResize)
		return () => {
			offLog()
			offStatus()
			offVite?.()
			clearInterval(clock)
			clearTimeout(timer)
			clearTimeout(statusTimer)
			stdout.off('resize', onResize)
		}
	}, [aux, vite, stdout])

	useInput((input, key) => {
		if (input === 'q' || (key.ctrl && input === 'c')) exit()
		else if (input === 'c') setLogs([])
		else if (input === 'o') onOpen?.()
	})

	const headerRows = 7
	const visible = Math.max(1, size.rows - headerRows)
	const shown = logs.slice(-visible)
	void tick

	return html`<${Box} flexDirection="column" height=${size.rows}>
		<${Box}>
			<${Text} bold color="cyan"> Koma Aux</${Text}>
			<${Text} dimColor>  v${version}</${Text}>
			<${Box} flexGrow=${1} />
			<${Text} dimColor>q quit · c clear · o open </${Text}>
		</${Box}>
		<${PtpRow} ptp=${aux.status.ptp} />
		<${OscRow} osc=${aux.status.osc} />
		<${McpRow} tools=${aux.status.tools} />
		<${ViteRow} vite=${vite?.status} />
		<${Text} dimColor>${'─'.repeat(Math.max(1, size.columns))}</${Text}>
		<${Box} flexDirection="column" height=${visible} overflow="hidden">
			${shown.map((entry, i) => html`<${LogLine} key=${`${entry.t}-${i}`} entry=${entry} columns=${size.columns} />`)}
		</${Box}>
	</${Box}>`
}

export function renderUi({aux, vite, version, onQuit}) {
	const onOpen = () => {
		const url = vite?.status?.url
		if (!url) return
		const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open'
		exec(`${cmd} ${JSON.stringify(url)}`)
	}
	const instance = render(html`<${App} aux=${aux} vite=${vite} version=${version} onOpen=${onOpen} />`, {
		exitOnCtrlC: false,
	})
	instance.waitUntilExit().then(() => onQuit?.())
	return instance
}

/** Line-per-event output for a non-interactive terminal (pipes, CI). */
export function renderPlain({aux, vite, version}) {
	// eslint-disable-next-line no-console
	const out = (...a) => console.log(...a)
	out(`Koma Aux v${version}`)
	for (const e of aux.history) out(`${time(e.t)} [${e.tag}] ${e.text}`)
	aux.on('log', e => out(`${time(e.t)} [${e.tag}] ${e.text}`))
	vite?.on(() => {
		const s = vite.status
		if (s.state === 'ready') out(`${time(Date.now())} [vite] ${s.url}`)
		else if (s.state === 'error') out(`${time(Date.now())} [vite] ${s.error}`)
	})
}
