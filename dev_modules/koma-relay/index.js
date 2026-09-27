#!/usr/bin/env node
/**
 * koma-relay — the always-on half of the exhibition setup (ADDSUB.md §15).
 *
 * Runs on the exhibit machine (the Mac mini). The shooting machine's koma is
 * a *client* of it: it pushes the display copy of the project (project.json,
 * the `_lv` previews, previz/frames.json + the G-code it references) over
 * HTTP and publishes its live state (machine positions, sequence step, the
 * G-code line being sent) over a WebSocket. The exhibit pages, served from
 * here too, read the project copy back over HTTP and subscribe to the same
 * WebSocket — so when the shooting machine is switched off or taken away,
 * the screens keep running from the last pushed copy, and the live panes
 * just say "offline".
 *
 * The live view itself never passes through here: capture and exhibit
 * negotiate a WebRTC connection (offer/answer/ICE relayed as `signal`
 * messages) and the video flows peer-to-peer over the direct Ethernet link.
 *
 *   node index.js --dir <project copy> [--port 7777] [--static <dist>] [--token <t>]
 *
 *   GET  /                      → /exhibit.html
 *   GET  /<static file>         built koma (dist/), for the kiosk browser
 *   GET  /project/<rel>         a file of the project copy (ETag = size-mtime)
 *   GET  /api/manifest          {files: {rel: {size, mtime}}}
 *   PUT  /api/file/<rel>        write a file (atomic: tmp + rename); X-Mtime header
 *   DELETE /api/file/<rel>
 *   WS   /ws?role=capture|exhibit
 *
 * WebSocket protocol (JSON text frames):
 *   capture → server : {type:'state', topic, data}   latest per topic is kept
 *                      {type:'signal', to, data}     WebRTC signalling
 *   exhibit → server : {type:'signal', data}         (to the capture)
 *   server  → capture: {type:'hello', id, peers:[exhibitId…]}
 *                      {type:'peer', id, online}
 *                      {type:'signal', from, data}
 *   server  → exhibit: {type:'hello', id, capture:bool, state:{topic:{data,t}}}
 *                      {type:'capture', online}      capture came / went
 *                      {type:'state', topic, data, t}
 *                      {type:'file', rel, size, mtime} a file was pushed
 *                      {type:'signal', from, data}
 */

import {createServer} from 'node:http'
import {createReadStream} from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {randomBytes} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {WebSocketServer} from 'ws'

//------------------------------------------------------------------------------
// Arguments

const args = parseArgs(process.argv.slice(2))
const PORT = Number(args.port ?? process.env.KOMA_RELAY_PORT ?? 7777)
const DIR = path.resolve(args.dir ?? process.env.KOMA_RELAY_DIR ?? './project')
const STATIC = path.resolve(
	args.static ??
		process.env.KOMA_RELAY_STATIC ??
		path.join(path.dirname(fileURLToPath(import.meta.url)), '../../dist')
)
const TOKEN = args.token ?? process.env.KOMA_RELAY_TOKEN ?? ''

function parseArgs(argv) {
	const out = {}
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (!a.startsWith('--')) continue
		const key = a.slice(2)
		const next = argv[i + 1]
		if (next !== undefined && !next.startsWith('--')) {
			out[key] = next
			i++
		} else {
			out[key] = true
		}
	}
	return out
}

await fs.mkdir(DIR, {recursive: true})

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
	'.mp4': 'video/mp4',
	'.webmanifest': 'application/manifest+json',
	'.woff2': 'font/woff2',
	'.woff': 'font/woff',
	'.ttf': 'font/ttf',
	'.nc': 'text/plain; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.glb': 'model/gltf-binary',
	'.gltf': 'model/gltf+json',
	'.wasm': 'application/wasm',
	'.map': 'application/json',
}

const mimeOf = p => MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream'

const log = (...a) => {
	const t = new Date().toISOString().slice(11, 19)
	// eslint-disable-next-line no-console
	console.log(t, ...a)
}

/** Resolve a relative path inside `root`, refusing anything that escapes it. */
function safeJoin(root, rel) {
	const decoded = decodeURIComponent(rel).replace(/\\/g, '/')
	if (decoded.split('/').some(p => p === '..')) return null
	const full = path.resolve(root, '.' + path.posix.normalize('/' + decoded))
	if (full !== root && !full.startsWith(root + path.sep)) return null
	return full
}

//------------------------------------------------------------------------------
// HTTP

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Mtime, X-Token',
	'Access-Control-Expose-Headers': 'ETag, Last-Modified',
}

function send(res, status, body, headers = {}) {
	res.writeHead(status, {...CORS, ...headers})
	res.end(body)
}

function sendJson(res, status, obj) {
	send(res, status, JSON.stringify(obj), {'Content-Type': 'application/json; charset=utf-8'})
}

function authorized(req) {
	if (!TOKEN) return true
	return req.headers['x-token'] === TOKEN
}

async function serveFile(req, res, full, {noStore = false} = {}) {
	let st
	try {
		st = await fs.stat(full)
	} catch {
		return send(res, 404, 'not found')
	}
	if (!st.isFile()) return send(res, 404, 'not found')
	const etag = `"${st.size}-${Math.round(st.mtimeMs)}"`
	if (req.headers['if-none-match'] === etag) return send(res, 304, '', {ETag: etag})
	res.writeHead(200, {
		...CORS,
		'Content-Type': mimeOf(full),
		'Content-Length': st.size,
		ETag: etag,
		'Last-Modified': st.mtime.toUTCString(),
		'Cache-Control': noStore ? 'no-store' : 'no-cache',
	})
	if (req.method === 'HEAD') return res.end()
	createReadStream(full).pipe(res)
}

async function listFiles(root) {
	const out = {}
	async function walk(dir, prefix) {
		let entries
		try {
			entries = await fs.readdir(dir, {withFileTypes: true})
		} catch {
			return
		}
		for (const e of entries) {
			if (e.name.startsWith('.')) continue
			const rel = prefix ? `${prefix}/${e.name}` : e.name
			if (e.isDirectory()) await walk(path.join(dir, e.name), rel)
			else if (e.isFile()) {
				try {
					const st = await fs.stat(path.join(dir, e.name))
					out[rel] = {size: st.size, mtime: Math.round(st.mtimeMs)}
				} catch {
					// vanished mid-walk
				}
			}
		}
	}
	await walk(root, '')
	return out
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = []
		req.on('data', c => chunks.push(c))
		req.on('end', () => resolve(Buffer.concat(chunks)))
		req.on('error', reject)
	})
}

async function putFile(req, res, rel) {
	const full = safeJoin(DIR, rel)
	if (!full || full === DIR) return send(res, 400, 'bad path')
	const body = await readBody(req)
	const mtime = Number(req.headers['x-mtime'])
	await fs.mkdir(path.dirname(full), {recursive: true})
	// Atomic on the same filesystem: readers never see a half-written file.
	const tmp = `${full}.tmp-${randomBytes(4).toString('hex')}`
	try {
		await fs.writeFile(tmp, body)
		if (Number.isFinite(mtime) && mtime > 0) {
			const d = new Date(mtime)
			await fs.utimes(tmp, d, d)
		}
		await fs.rename(tmp, full)
	} catch (e) {
		await fs.rm(tmp, {force: true}).catch(() => {})
		throw e
	}
	const st = await fs.stat(full)
	const info = {size: st.size, mtime: Math.round(st.mtimeMs)}
	broadcast('exhibit', {type: 'file', rel: decodeURIComponent(rel), ...info})
	sendJson(res, 200, info)
}

async function deleteFile(res, rel) {
	const full = safeJoin(DIR, rel)
	if (!full || full === DIR) return send(res, 400, 'bad path')
	await fs.rm(full, {force: true})
	send(res, 204, '')
}

const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url, 'http://localhost')
		const p = url.pathname
		if (req.method === 'OPTIONS') return send(res, 204, '')

		if (p === '/api/manifest') {
			if (!authorized(req)) return send(res, 401, 'unauthorized')
			return sendJson(res, 200, {dir: DIR, files: await listFiles(DIR)})
		}
		if (p === '/api/status') {
			return sendJson(res, 200, {
				capture: capture !== null,
				exhibits: [...exhibits.keys()],
				topics: Object.keys(latest),
			})
		}
		if (p.startsWith('/api/file/')) {
			if (!authorized(req)) return send(res, 401, 'unauthorized')
			const rel = p.slice('/api/file/'.length)
			if (req.method === 'PUT') return await putFile(req, res, rel)
			if (req.method === 'DELETE') return await deleteFile(res, rel)
			return send(res, 405, 'method not allowed')
		}
		if (p.startsWith('/project/')) {
			const full = safeJoin(DIR, p.slice('/project/'.length))
			if (!full) return send(res, 400, 'bad path')
			return await serveFile(req, res, full, {noStore: full.endsWith('.json')})
		}
		if (p === '/') {
			return send(res, 302, '', {Location: '/exhibit.html'})
		}
		// Static (built koma). Unknown extension-less paths fall back to the
		// exhibit page so a bookmarked route still opens something.
		const full = safeJoin(STATIC, p.slice(1))
		if (!full) return send(res, 400, 'bad path')
		try {
			const st = await fs.stat(full)
			if (st.isFile()) return await serveFile(req, res, full)
		} catch {
			// fall through
		}
		if (!path.extname(p)) {
			return await serveFile(req, res, path.join(STATIC, 'exhibit.html'))
		}
		send(res, 404, 'not found')
	} catch (e) {
		log('error', req.method, req.url, e?.message ?? e)
		if (!res.headersSent) send(res, 500, String(e?.message ?? e))
		else res.end()
	}
})

//------------------------------------------------------------------------------
// WebSocket: one capture, many exhibits

const wss = new WebSocketServer({noServer: true})

/** @type {import('ws').WebSocket | null} */
let capture = null
/** @type {Map<string, import('ws').WebSocket>} */
const exhibits = new Map()
/** Latest published state per topic, replayed to exhibits when they connect. */
const latest = {}

const newId = () => randomBytes(4).toString('hex')

function sendTo(ws, msg) {
	if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(role, msg) {
	if (role === 'exhibit') for (const ws of exhibits.values()) sendTo(ws, msg)
	else sendTo(capture, msg)
}

server.on('upgrade', (req, socket, head) => {
	const url = new URL(req.url, 'http://localhost')
	if (url.pathname !== '/ws') {
		socket.destroy()
		return
	}
	const role = url.searchParams.get('role')
	if (role !== 'capture' && role !== 'exhibit') {
		socket.destroy()
		return
	}
	if (role === 'capture' && TOKEN && url.searchParams.get('token') !== TOKEN) {
		socket.destroy()
		return
	}
	wss.handleUpgrade(req, socket, head, ws => onConnection(ws, role, req))
})

function onConnection(ws, role, req) {
	const id = newId()
	ws.isAlive = true
	ws.on('pong', () => (ws.isAlive = true))
	const from = req.socket.remoteAddress

	if (role === 'capture') {
		if (capture) {
			log('capture replaced (a newer shooting machine connected)')
			capture.close(4000, 'replaced')
		}
		capture = ws
		log(`capture connected from ${from}`)
		sendTo(ws, {type: 'hello', id, role, peers: [...exhibits.keys()]})
		broadcast('exhibit', {type: 'capture', online: true, t: Date.now()})
		ws.on('message', raw => {
			let msg
			try {
				msg = JSON.parse(String(raw))
			} catch {
				return
			}
			if (msg.type === 'state' && typeof msg.topic === 'string') {
				const entry = {data: msg.data, t: Date.now()}
				latest[msg.topic] = entry
				broadcast('exhibit', {type: 'state', topic: msg.topic, ...entry})
			} else if (msg.type === 'signal' && typeof msg.to === 'string') {
				sendTo(exhibits.get(msg.to), {type: 'signal', from: id, data: msg.data})
			}
		})
		ws.on('close', () => {
			if (capture !== ws) return
			capture = null
			log('capture disconnected')
			broadcast('exhibit', {type: 'capture', online: false, t: Date.now()})
		})
	} else {
		exhibits.set(id, ws)
		log(`exhibit ${id} connected from ${from} (${exhibits.size} total)`)
		sendTo(ws, {type: 'hello', id, role, capture: capture !== null, state: latest})
		sendTo(capture, {type: 'peer', id, online: true})
		ws.on('message', raw => {
			let msg
			try {
				msg = JSON.parse(String(raw))
			} catch {
				return
			}
			if (msg.type === 'signal') {
				sendTo(capture, {type: 'signal', from: id, data: msg.data})
			}
		})
		ws.on('close', () => {
			exhibits.delete(id)
			log(`exhibit ${id} disconnected (${exhibits.size} left)`)
			sendTo(capture, {type: 'peer', id, online: false})
		})
	}
}

// Keepalive: drop sockets that stopped answering pings (a shooting machine
// put to sleep, an unplugged cable) so `capture online` is truthful.
const PING_MS = 10_000
setInterval(() => {
	for (const ws of wss.clients) {
		if (ws.isAlive === false) {
			ws.terminate()
			continue
		}
		ws.isAlive = false
		ws.ping()
	}
}, PING_MS).unref()

server.listen(PORT, () => {
	log(`koma-relay listening on http://0.0.0.0:${PORT}`)
	log(`  project copy : ${DIR}`)
	log(`  static pages : ${STATIC}`)
	log(`  token        : ${TOKEN ? 'required' : 'none'}`)
})
