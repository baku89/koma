/**
 * The tools koma offers to the outside — Claude Code over MCP, scripts over
 * plain HTTP — through the aux tools bridge
 * (dev_modules/aux-manager/lib/toolsBridge.js, port 8090; `yarn dev` /
 * `yarn aux` from a terminal, or inside the desktop app's main process).
 *
 * A browser tab cannot listen on a port, so koma *connects* to the bridge
 * (WebSocket /tools) as the provider of its tools: it sends the list, and the
 * bridge hands every MCP tools/call back here as {type: 'call', id, name,
 * arguments}. The tools themselves are registered by whoever owns the data
 * (`registerTool`): the inbox ops (stores/inbox.ts) become one tool each,
 * stores/projectTools.ts and addsub/tools.ts add the read side.
 *
 * What a tool's `execute` returns is the result: a string as text, anything
 * else as JSON. Throwing makes the call fail with the error's message.
 */

import {defineStore} from 'pinia'
import {ref, watch} from 'vue'

import {useProjectStore} from './project'

/**
 * Where aux is (`yarn dev` / `yarn aux`, or the desktop app's built-in one).
 * `?aux=http://127.0.0.1:8091` on the page URL points a second koma at
 * another aux (tests, two koma side by side).
 */
export const AUX_HTTP_URL = (() => {
	const fallback = 'http://127.0.0.1:8090'
	if (typeof location === 'undefined') return fallback
	const q = new URLSearchParams(location.search).get('aux')
	return q ? q.replace(/\/$/, '') : fallback
})()

export const TOOLS_BRIDGE_URL = `${AUX_HTTP_URL.replace(/^http/, 'ws')}/tools`
const RECONNECT_MS = 2000

export interface ToolDefinition {
	/** snake_case, as MCP clients see it. */
	name: string
	description: string
	/** JSON Schema of the arguments (an object schema). */
	inputSchema: Record<string, unknown>
	execute: (args: Record<string, any>) => unknown
}

const registry = new Map<string, ToolDefinition>()
const onRegistryChange = new Set<() => void>()

/** Register (or replace) a tool. */
export function registerTool(def: ToolDefinition) {
	registry.set(def.name, def)
	onRegistryChange.forEach(fn => fn())
}

export function registeredTools(): ToolDefinition[] {
	return [...registry.values()]
}

export interface ToolCallRecord {
	name: string
	ok: boolean
	at: number
	ms: number
	error?: string
}

export const useToolsStore = defineStore('tools', () => {
	const project = useProjectStore()

	const connected = ref(false)
	const calls = ref(0)
	const lastCall = ref<ToolCallRecord | null>(null)
	/** Why the last attempt failed (null while connected or before the first try). */
	const lastError = ref<string | null>(null)

	let ws: WebSocket | null = null
	let retry: ReturnType<typeof setTimeout> | null = null

	function send(msg: unknown) {
		if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
	}

	function sendHello() {
		send({
			type: 'hello',
			app: {name: 'koma', project: project.name, origin: location.origin},
		})
	}

	function sendTools() {
		send({
			type: 'tools',
			tools: registeredTools().map(({name, description, inputSchema}) => ({
				name,
				description,
				inputSchema,
			})),
		})
	}

	// Many tools register in a row at startup: one list per tick.
	let listPending = false
	onRegistryChange.add(() => {
		if (listPending || !connected.value) return
		listPending = true
		queueMicrotask(() => {
			listPending = false
			sendTools()
		})
	})

	watch(() => project.name, sendHello)

	async function handleCall(id: unknown, name: unknown, args: unknown) {
		const started = performance.now()
		const tool = typeof name === 'string' ? registry.get(name) : undefined
		let reply: {ok: true; result: unknown} | {ok: false; error: string}
		if (!tool) {
			reply = {ok: false, error: `unknown tool "${String(name)}"`}
		} else {
			try {
				const input = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, any>) : {}
				reply = {ok: true, result: (await tool.execute(input)) ?? null}
			} catch (e) {
				reply = {ok: false, error: e instanceof Error ? e.message : String(e)}
			}
		}
		calls.value += 1
		lastCall.value = {
			name: String(name),
			ok: reply.ok,
			at: Date.now(),
			ms: Math.round(performance.now() - started),
			...(reply.ok ? {} : {error: reply.error}),
		}
		send({type: 'result', id, ...reply})
	}

	function scheduleReconnect() {
		if (retry) return
		retry = setTimeout(() => {
			retry = null
			connect()
		}, RECONNECT_MS)
	}

	function connect() {
		if (ws) return
		let socket: WebSocket
		try {
			socket = new WebSocket(TOOLS_BRIDGE_URL)
		} catch (e) {
			lastError.value = e instanceof Error ? e.message : String(e)
			scheduleReconnect()
			return
		}
		ws = socket
		socket.onopen = () => {
			connected.value = true
			lastError.value = null
			sendHello()
			sendTools()
		}
		socket.onmessage = e => {
			let msg: any
			try {
				msg = JSON.parse(String(e.data))
			} catch {
				return
			}
			if (msg?.type === 'call') void handleCall(msg.id, msg.name, msg.arguments)
		}
		socket.onerror = () => {
			// The close that follows does the bookkeeping; without a bridge
			// running this fires every RECONNECT_MS, quietly.
			lastError.value = `no tools bridge at ${AUX_HTTP_URL} (run yarn dev / yarn aux, or the desktop app)`
		}
		socket.onclose = ev => {
			if (ws !== socket) return
			ws = null
			connected.value = false
			if (ev.code === 4000) lastError.value = `bridge: ${ev.reason || 'replaced'}`
			scheduleReconnect()
		}
	}

	connect()

	return {connected, calls, lastCall, lastError, url: TOOLS_BRIDGE_URL}
})
