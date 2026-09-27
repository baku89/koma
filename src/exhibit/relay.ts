/**
 * The exhibition screens' end of koma-relay (dev_modules/koma-relay):
 * subscribes to the shooting machine's live state (`topics`), learns when a
 * file of the display copy was pushed (`onFile`, so project.json is re-read
 * at once instead of on the next poll), and receives the live view over
 * WebRTC — the relay only carries the signalling.
 *
 * Everything here is optional: without a relay (a picked folder, a test) the
 * screens just never see the shooting machine as online.
 */

import {createEventHook} from '@vueuse/core'
import {computed, readonly, ref, shallowReactive, shallowRef} from 'vue'

export interface TopicEntry<T = any> {
	data: T
	/** Server time the value was published (ms). */
	t: number
}

const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 10_000

const base = ref<string | null>(null)
const connected = ref(false)
const captureOnline = ref(false)
/** When the shooting machine was last seen online (ms), if ever. */
const captureLastSeen = ref<number | null>(null)
const topics = shallowReactive<Record<string, TopicEntry>>({})
const liveStream = shallowRef<MediaStream | null>(null)
/**
 * False while the remote track is muted — the shooting machine switched its
 * live view off (replaceTrack(null)) and the <video> is frozen on the last
 * frame, which the pane should say rather than pass off as live.
 */
const liveActive = ref(false)
const fileHook = createEventHook<{rel: string; size: number; mtime: number}>()

let ws: WebSocket | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let backoff = RECONNECT_MIN_MS
let generation = 0
let wantLive = 0
let pc: RTCPeerConnection | null = null

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
	const url = base.value.replace(/^http/, 'ws') + '/ws?role=exhibit'
	let socket: WebSocket
	try {
		socket = new WebSocket(url)
	} catch {
		scheduleReconnect()
		return
	}
	ws = socket
	socket.onopen = () => {
		if (gen !== generation) return
		connected.value = true
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
				setCaptureOnline(!!msg.capture)
				break
			case 'capture':
				setCaptureOnline(!!msg.online)
				break
			case 'state':
				topics[msg.topic] = {data: msg.data, t: msg.t}
				break
			case 'file':
				fileHook.trigger({rel: msg.rel, size: msg.size, mtime: msg.mtime})
				break
			case 'signal':
				void onSignal(msg.data)
				break
		}
	}
	socket.onclose = () => {
		if (gen !== generation) return
		ws = null
		connected.value = false
		setCaptureOnline(false)
		scheduleReconnect()
	}
	socket.onerror = () => {
		// onclose follows
	}
}

function setCaptureOnline(online: boolean) {
	if (online) captureLastSeen.value = Date.now()
	if (captureOnline.value === online) return
	captureOnline.value = online
	if (online) {
		if (wantLive > 0) send({type: 'signal', data: {kind: 'want-live'}})
	} else {
		closePeer()
	}
}

/** Connect to the relay at `url` (`http://host:port`). */
function connect(url: string) {
	const clean = url.replace(/\/+$/, '')
	if (base.value === clean && ws) return
	disconnect()
	base.value = clean
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
	setCaptureOnline(false)
}

//------------------------------------------------------------------------------
// Live view (answerer)

function closePeer() {
	if (pc) {
		try {
			pc.close()
		} catch {
			// ignore
		}
		pc = null
	}
	liveStream.value = null
	liveActive.value = false
}

async function onSignal(data: any) {
	if (!data || typeof data !== 'object') return
	if (data.kind === 'offer') {
		closePeer()
		const conn = new RTCPeerConnection({iceServers: []})
		pc = conn
		conn.ontrack = ev => {
			if (pc !== conn) return
			const track = ev.track
			liveStream.value = ev.streams[0] ?? new MediaStream([track])
			liveActive.value = !track.muted
			track.onmute = () => (liveActive.value = false)
			track.onunmute = () => (liveActive.value = true)
			track.onended = () => (liveActive.value = false)
		}
		conn.onicecandidate = ev => {
			if (ev.candidate) send({type: 'signal', data: {kind: 'ice', candidate: ev.candidate.toJSON()}})
		}
		conn.onconnectionstatechange = () => {
			if (pc !== conn) return
			if (conn.connectionState === 'failed' || conn.connectionState === 'closed') {
				closePeer()
				// Ask again; the shooting machine may just have restarted the view.
				if (captureOnline.value && wantLive > 0) {
					send({type: 'signal', data: {kind: 'want-live'}})
				}
			}
		}
		try {
			await conn.setRemoteDescription(data.sdp)
			const answer = await conn.createAnswer()
			await conn.setLocalDescription(answer)
			send({type: 'signal', data: {kind: 'answer', sdp: conn.localDescription}})
		} catch {
			closePeer()
		}
	} else if (data.kind === 'ice') {
		if (pc && data.candidate) await pc.addIceCandidate(data.candidate).catch(() => {})
	}
}

/**
 * Declare interest in the live view (a pane showing it). Returns a release
 * function; the stream is requested while at least one holder exists.
 */
function requestLive() {
	wantLive++
	if (wantLive === 1 && captureOnline.value) {
		send({type: 'signal', data: {kind: 'want-live'}})
	}
	return () => {
		wantLive = Math.max(0, wantLive - 1)
		if (wantLive === 0) {
			send({type: 'signal', data: {kind: 'bye'}})
			closePeer()
		}
	}
}

export function useExhibitRelay() {
	return {
		base: readonly(base),
		connected: readonly(connected),
		captureOnline: readonly(captureOnline),
		captureLastSeen: readonly(captureLastSeen),
		topics,
		/** Typed accessor for one topic's latest value (null when never seen). */
		topic: <T = any>(name: string) => computed<TopicEntry<T> | null>(() => topics[name] ?? null),
		liveStream: readonly(liveStream),
		liveActive: readonly(liveActive),
		connect,
		disconnect,
		requestLive,
		onFile: fileHook.on,
	}
}
