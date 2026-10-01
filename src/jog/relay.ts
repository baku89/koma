/**
 * The phone's end of koma-relay: a `role=control` WebSocket that receives
 * the shooting machine's state topics (`machine:<id>`, `remoteJog`,
 * `jog:result`) and sends `jog` control messages, which the relay forwards
 * to koma (stores/remoteJog.ts). No WebRTC, no files.
 */

import {readonly, ref, shallowReactive} from 'vue'

export interface TopicEntry<T = any> {
	data: T
	t: number
}

const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 8000

const base = ref<string | null>(null)
const connected = ref(false)
const captureOnline = ref(false)
const rejected = ref(false)
const topics = shallowReactive<Record<string, TopicEntry>>({})

let ws: WebSocket | null = null
let token = ''
let retryTimer: ReturnType<typeof setTimeout> | null = null
let backoff = RECONNECT_MIN_MS
let generation = 0

function send(msg: unknown) {
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function scheduleReconnect() {
	if (retryTimer || !base.value) return
	retryTimer = setTimeout(() => {
		retryTimer = null
		open()
	}, backoff)
	backoff = Math.min(RECONNECT_MAX_MS, backoff * 2)
}

function open() {
	if (!base.value) return
	const gen = ++generation
	const t = token ? `&token=${encodeURIComponent(token)}` : ''
	const url = base.value.replace(/^http/, 'ws') + `/ws?role=control${t}`
	let socket: WebSocket
	try {
		socket = new WebSocket(url)
	} catch {
		scheduleReconnect()
		return
	}
	ws = socket
	let opened = false
	socket.onopen = () => {
		if (gen !== generation) return
		opened = true
		connected.value = true
		rejected.value = false
		backoff = RECONNECT_MIN_MS
	}
	socket.onmessage = ev => {
		if (gen !== generation) return
		let msg: any
		try {
			msg = JSON.parse(String(ev.data))
		} catch {
			return
		}
		switch (msg.type) {
			case 'hello':
				for (const [topic, entry] of Object.entries(msg.state ?? {})) {
					topics[topic] = entry as TopicEntry
				}
				captureOnline.value = !!msg.capture
				break
			case 'capture':
				captureOnline.value = !!msg.online
				break
			case 'state':
				topics[msg.topic] = {data: msg.data, t: msg.t}
				break
		}
	}
	socket.onclose = () => {
		if (gen !== generation) return
		ws = null
		connected.value = false
		captureOnline.value = false
		// The relay destroys the socket before the handshake when the token is
		// wrong (or the role is refused): report it instead of just retrying.
		if (!opened) rejected.value = true
		scheduleReconnect()
	}
	socket.onerror = () => {
		// onclose follows
	}
}

/** Connect to the relay at `url` (`http://host:port`) with an optional token. */
function connect(url: string, t = '') {
	const clean = url.replace(/\/+$/, '')
	if (base.value === clean && token === t && ws) return
	disconnect()
	base.value = clean
	token = t
	open()
}

function disconnect() {
	if (retryTimer) {
		clearTimeout(retryTimer)
		retryTimer = null
	}
	generation++
	ws?.close()
	ws = null
	base.value = null
	connected.value = false
	captureOnline.value = false
}

/** Send a control message to the shooting machine. */
function control(topic: string, data: unknown) {
	send({type: 'control', topic, data})
}

export function useJogRelay() {
	return {
		base: readonly(base),
		connected: readonly(connected),
		captureOnline: readonly(captureOnline),
		rejected: readonly(rejected),
		topics,
		connect,
		disconnect,
		control,
	}
}
