/**
 * The tools bridge: the MCP server through which Claude Code (and scripts)
 * edit the project open in koma.
 *
 * koma holds the project in memory and is the only writer of project.json,
 * and a browser tab cannot listen on a port — so koma connects *here*
 * (WebSocket /tools) as the *provider* of its tools, and this process hosts
 * the MCP endpoint that forwards every tools/list and tools/call to it. The
 * bridge knows nothing about the tools themselves; their names, schemas and
 * behaviour all come from koma (src/stores/tools.ts).
 *
 *   http://127.0.0.1:8090/mcp      MCP, Streamable HTTP (sessions kept so the
 *                                  client is told when koma's tool list changes)
 *   POST /call  {name, arguments}  one tool call, plain JSON (for scripts)
 *   GET  /tools                    the current tool list
 *   GET  /status                   provider, counters
 *   ws   /tools                    koma (the provider)
 *   POST /video, GET /video/<id>   frames of a video clip through ffmpeg (video.js)
 *
 * Provider protocol (koma → bridge):
 *   {type: 'hello', app: {name, project, origin}}
 *   {type: 'tools', tools: [{name, description, inputSchema}]}
 *   {type: 'result', id, ok: true, result} | {type: 'result', id, ok: false, error}
 * bridge → koma:
 *   {type: 'call', id, name, arguments}
 * A new provider replaces the previous one (the last koma to connect wins).
 */
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'

import {Server} from '@modelcontextprotocol/sdk/server/index.js'
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
	CallToolRequestSchema,
	isInitializeRequest,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {WebSocketServer} from 'ws'

import {createVideoRoutes} from './video.js'

export const TOOLS_PORT = 8090

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'content-type, mcp-session-id, mcp-protocol-version, last-event-id, x-koma-name',
	'Access-Control-Expose-Headers': 'mcp-session-id',
}

export function startToolsBridge({
	port = TOOLS_PORT,
	host = '127.0.0.1',
	version = '0.0.0',
	callTimeoutMs = 120_000,
	log = () => {},
	onStatus,
} = {}) {
	const status = {
		state: 'off',
		host,
		port,
		error: null,
		provider: null,
		tools: 0,
		calls: 0,
		lastCall: null,
		sessions: 0,
	}
	const changed = () => onStatus?.(status)

	//--------------------------------------------------------------------------
	// Provider (koma)

	let provider = null
	let nextCallId = 1

	function setProvider(ws, req) {
		if (provider) {
			log('tools', 'another koma connected — replacing the previous one', 'warn')
			dropProvider(provider, 'replaced by a new connection')
		}
		const p = {
			ws,
			app: {name: 'koma', project: null, origin: req.headers.origin ?? null},
			tools: [],
			pending: new Map(),
			since: Date.now(),
		}
		provider = p
		ws.on('message', data => {
			let msg
			try {
				msg = JSON.parse(String(data))
			} catch {
				return
			}
			if (provider !== p) return
			if (msg.type === 'hello' && msg.app && typeof msg.app === 'object') {
				p.app = {...p.app, ...msg.app}
				publish()
				log('tools', `koma connected${p.app.project ? ` — "${p.app.project}"` : ''}`)
			} else if (msg.type === 'tools' && Array.isArray(msg.tools)) {
				p.tools = msg.tools.filter(t => t && typeof t.name === 'string')
				publish()
				notifyToolsChanged()
				log('tools', `${p.tools.length} tools: ${p.tools.map(t => t.name).join(', ')}`)
			} else if (msg.type === 'result') {
				const call = p.pending.get(msg.id)
				if (!call) return
				p.pending.delete(msg.id)
				clearTimeout(call.timer)
				if (msg.ok) call.resolve(msg.result)
				else call.reject(new Error(typeof msg.error === 'string' ? msg.error : 'tool failed'))
			}
		})
		ws.on('close', () => {
			if (provider !== p) return
			dropProvider(p, 'koma disconnected')
			provider = null
			publish()
			notifyToolsChanged()
			log('tools', 'koma disconnected')
		})
		ws.on('error', e => log('tools', `provider socket: ${e?.message ?? e}`, 'warn'))
		ws.send(JSON.stringify({type: 'welcome', version}))
		publish()
	}

	function dropProvider(p, why) {
		for (const call of p.pending.values()) {
			clearTimeout(call.timer)
			call.reject(new Error(why))
		}
		p.pending.clear()
		try {
			p.ws.close(4000, why)
		} catch {
			// Already gone.
		}
	}

	function publish() {
		status.provider = provider
			? {project: provider.app.project ?? null, origin: provider.app.origin, since: provider.since}
			: null
		status.tools = provider?.tools.length ?? 0
		changed()
	}

	function tools() {
		return provider?.tools ?? []
	}

	/** Run one tool in koma; resolves with whatever koma's execute returned. */
	function callTool(name, args = {}) {
		if (!provider) {
			return Promise.reject(
				new Error('koma is not connected to the tools bridge (open koma; it connects to this process by itself)')
			)
		}
		if (!provider.tools.some(t => t.name === name)) {
			return Promise.reject(new Error(`unknown tool "${name}" (have: ${provider.tools.map(t => t.name).join(', ')})`))
		}
		const p = provider
		const id = nextCallId++
		const started = Date.now()
		status.calls += 1
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				p.pending.delete(id)
				reject(new Error(`"${name}" did not answer within ${callTimeoutMs / 1000} s`))
			}, callTimeoutMs)
			p.pending.set(id, {resolve, reject, timer})
			p.ws.send(JSON.stringify({type: 'call', id, name, arguments: args}))
		}).then(
			result => {
				record(name, true, started)
				return result
			},
			err => {
				record(name, false, started, err.message)
				throw err
			}
		)
	}

	function record(name, ok, started, error) {
		const ms = Date.now() - started
		status.lastCall = {name, ok, ms, at: Date.now(), error: error ?? null}
		log('mcp', `${name} ${ms} ms ${ok ? 'ok' : `— ${error}`}`, ok ? 'info' : 'warn')
		changed()
	}

	//--------------------------------------------------------------------------
	// MCP (Streamable HTTP, one Server per session)

	const sessions = new Map()

	function toContent(result) {
		if (result && typeof result === 'object' && Array.isArray(result.content)) return result
		const text = typeof result === 'string' ? result : JSON.stringify(result ?? null, null, 2)
		const out = {content: [{type: 'text', text}]}
		if (result && typeof result === 'object' && !Array.isArray(result)) out.structuredContent = result
		return out
	}

	function createMcpServer() {
		const server = new Server({name: 'koma', version}, {capabilities: {tools: {listChanged: true}}})
		server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: tools()}))
		server.setRequestHandler(CallToolRequestSchema, async req => {
			try {
				return toContent(await callTool(req.params.name, req.params.arguments ?? {}))
			} catch (e) {
				return {content: [{type: 'text', text: e instanceof Error ? e.message : String(e)}], isError: true}
			}
		})
		return server
	}

	function notifyToolsChanged() {
		for (const s of sessions.values()) {
			s.server.sendToolListChanged().catch(() => {})
		}
	}

	async function handleMcp(req, res, body) {
		const sid = req.headers['mcp-session-id']
		const session = typeof sid === 'string' ? sessions.get(sid) : undefined
		if (session) {
			await session.transport.handleRequest(req, res, body)
			return
		}
		if (req.method !== 'POST' || !isInitializeRequest(body)) {
			json(res, 400, {
				jsonrpc: '2.0',
				error: {code: -32000, message: sid ? 'Unknown or expired session; initialize again' : 'No session: send an initialize request first'},
				id: null,
			})
			return
		}
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: id => {
				sessions.set(id, {transport, server})
				status.sessions = sessions.size
				changed()
				log('mcp', `client connected (${sessions.size} session${sessions.size === 1 ? '' : 's'})`)
			},
		})
		transport.onclose = () => {
			const id = transport.sessionId
			if (id && sessions.delete(id)) {
				status.sessions = sessions.size
				changed()
				log('mcp', `client left (${sessions.size} left)`)
			}
		}
		const server = createMcpServer()
		await server.connect(transport)
		await transport.handleRequest(req, res, body)
	}

	//--------------------------------------------------------------------------
	// HTTP

	const video = createVideoRoutes({log})

	function json(res, code, data) {
		res.writeHead(code, {'content-type': 'application/json', ...CORS})
		res.end(JSON.stringify(data))
	}

	function readBody(req) {
		return new Promise((resolve, reject) => {
			const chunks = []
			req.on('data', c => chunks.push(c))
			req.on('end', () => {
				const text = Buffer.concat(chunks).toString('utf8')
				if (!text) return resolve(undefined)
				try {
					resolve(JSON.parse(text))
				} catch (e) {
					reject(e)
				}
			})
			req.on('error', reject)
		})
	}

	const httpServer = createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`)
		const p = url.pathname
		try {
			if (req.method === 'OPTIONS') {
				res.writeHead(204, CORS)
				res.end()
				return
			}
			// Video frames through ffmpeg for a clip dropped on koma's timeline (video.js).
			if (p.startsWith('/video') && (await video.handle(req, res, p, CORS, json))) return
			if (p === '/mcp') {
				const body = req.method === 'POST' ? await readBody(req) : undefined
				await handleMcp(req, res, body)
				return
			}
			if (p === '/call' && req.method === 'POST') {
				const body = (await readBody(req)) ?? {}
				if (typeof body.name !== 'string') return json(res, 400, {ok: false, error: '"name" is required'})
				try {
					json(res, 200, {ok: true, result: await callTool(body.name, body.arguments ?? {})})
				} catch (e) {
					json(res, provider ? 200 : 503, {ok: false, error: e instanceof Error ? e.message : String(e)})
				}
				return
			}
			if (p === '/tools' && req.method === 'GET') return json(res, 200, {tools: tools()})
			if (p === '/status' && req.method === 'GET') return json(res, 200, status)
			json(res, 404, {ok: false, error: `no ${req.method} ${p} here`})
		} catch (e) {
			log('tools', `${req.method} ${p}: ${e?.message ?? e}`, 'error')
			if (!res.headersSent) json(res, 500, {ok: false, error: e?.message ?? String(e)})
			else res.end()
		}
	})

	const wss = new WebSocketServer({noServer: true})
	httpServer.on('upgrade', (req, socket, head) => {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`)
		if (url.pathname !== '/tools') {
			socket.destroy()
			return
		}
		wss.handleUpgrade(req, socket, head, ws => setProvider(ws, req))
	})

	httpServer.on('error', e => {
		status.state = 'error'
		status.error = e.code === 'EADDRINUSE' ? `port ${port} is taken (another aux / koma app running?)` : e.message
		changed()
		log('tools', status.error, 'error')
	})
	httpServer.listen(port, host, () => {
		status.state = 'listening'
		status.error = null
		changed()
		log('tools', `MCP at http://${host}:${port}/mcp`)
	})

	return {
		status,
		tools,
		callTool,
		get provider() {
			return provider
		},
		stop() {
			if (provider) dropProvider(provider, 'bridge stopped')
			provider = null
			for (const s of sessions.values()) s.transport.close().catch(() => {})
			sessions.clear()
			wss.close()
			httpServer.close()
			video.stop()
			status.state = 'off'
		},
	}
}
