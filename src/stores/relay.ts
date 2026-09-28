/**
 * Client of a `koma-relay` server (dev_modules/koma-relay): the always-on
 * machine that drives the exhibition screens.
 *
 * Three jobs, all fire-and-forget so the capture path never waits on them:
 *
 * 1. **Display copy of the project.** After every save (project.onSaved) the
 *    files the screens need — project.json, the `_lv` previews (live and in
 *    `_trash`) and whatever extra files were registered (previz/frames.json,
 *    the G-code it references…) — are pushed over HTTP. Only what changed
 *    goes: each wanted file carries a *tag* (the asset id for previews, a
 *    version stamp for extras). A file whose tag we already pushed is skipped
 *    outright; a file with a new tag is stat'ed and compared with the
 *    server's manifest (size + mtime) so that after a reload — when every
 *    asset gets a fresh session id — nothing is re-sent that is already there.
 *    project.json is always pushed last, so the screens never reference a
 *    file that hasn't arrived.
 *
 * 2. **Live state.** `publish(topic, data)` sends the latest value of a topic
 *    over the WebSocket; the server keeps it and replays it to screens that
 *    connect later. Publishers live where the data lives (machine stores,
 *    the sequence…) — this store is only the pipe.
 *
 * 3. **Live view over WebRTC.** `setLiveStream(stream)` hands over the
 *    camera's MediaStream (Tethr exposes the live view as one, whatever the
 *    camera). Screens that ask for it (`want-live`) each get a peer
 *    connection; the relay only carries the offer/answer/ICE messages, the
 *    video flows directly over the LAN. When Tethr restarts the live view
 *    (new stream), the track is swapped in with replaceTrack — no
 *    renegotiation.
 *
 * 4. **Control messages.** A third kind of client (`role=control`, e.g.
 *    Houdini) can send `{topic, data}` messages that the relay forwards here;
 *    `onControl(topic, handler)` hands them to whoever owns the topic (the LED
 *    store, the rig…). This store never acts on them itself.
 *
 * The server address is a per-machine setting (app config, not the
 * project): `http://koma-exhibit.local:7777`. Empty = off.
 */

import {createEventHook, useDocumentVisibility} from '@vueuse/core'
import {defineStore} from 'pinia'
import {useTweeq} from 'tweeq'
import {computed, readonly, ref, shallowRef, watch} from 'vue'

import {getAssetFilename, TRASH_DIR} from '@/utils/assets'

import {useProjectStore} from './project'

/** A file the screens need, with a cheap identity to skip re-sends. */
export interface WantedFile {
	/** Path relative to the project folder (also the path on the server). */
	rel: string
	/** Changes when the content under `rel` may have changed. */
	tag: string
}

export type ExtraFilesProvider = () => WantedFile[] | Promise<WantedFile[]>

interface ManifestEntry {
	size: number
	mtime: number
}

const PUSH_CONCURRENCY = 4
const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 10_000
const LIVE_MAX_BITRATE = 6_000_000

export const useRelayStore = defineStore('relay', () => {
	const Tq = useTweeq()
	const config = Tq.config.group('relay')
	const project = useProjectStore()

	/** e.g. `http://koma-exhibit.local:7777`. Empty disables everything. */
	const url = config.ref<string>('url', '')
	const token = config.ref<string>('token', '')

	const enabled = computed(() => url.value.trim() !== '')
	const httpBase = computed(() => url.value.trim().replace(/\/+$/, ''))

	const connected = ref(false)
	const connecting = ref(false)
	const error = ref<string | null>(null)
	/** Ids of exhibit screens currently connected to the relay. */
	const peers = ref<string[]>([])

	const syncing = ref(false)
	const pending = ref(0)
	const lastSyncAt = ref<number | null>(null)
	const syncError = ref<string | null>(null)
	/** Bytes pushed in this session (for the popover). */
	const pushedBytes = ref(0)

	//--------------------------------------------------------------------------
	// WebSocket

	let ws: WebSocket | null = null
	let retryTimer: ReturnType<typeof setTimeout> | null = null
	let backoff = RECONNECT_MIN_MS
	let generation = 0

	const signalHook = createEventHook<{from: string; data: any}>()
	const controlHandlers = new Map<string, Set<(data: any, from: string) => void>>()
	/** Last control message per topic (for the popover / debugging). */
	const lastControl = ref<{topic: string; from: string; t: number} | null>(null)
	const peerHook = createEventHook<{id: string; online: boolean}>()
	const connectedHook = createEventHook<void>()

	function headers(): Record<string, string> {
		return token.value ? {'X-Token': token.value} : {}
	}

	function wsUrl() {
		const base = httpBase.value.replace(/^http/, 'ws')
		const t = token.value ? `&token=${encodeURIComponent(token.value)}` : ''
		return `${base}/ws?role=capture${t}`
	}

	function scheduleReconnect() {
		if (retryTimer || !enabled.value) return
		retryTimer = setTimeout(() => {
			retryTimer = null
			connect()
		}, backoff)
		backoff = Math.min(RECONNECT_MAX_MS, backoff * 2)
	}

	function connect() {
		disconnect(false)
		if (!enabled.value) return
		const gen = ++generation
		connecting.value = true
		let socket: WebSocket
		try {
			socket = new WebSocket(wsUrl())
		} catch (e) {
			connecting.value = false
			error.value = e instanceof Error ? e.message : String(e)
			scheduleReconnect()
			return
		}
		ws = socket
		socket.onopen = () => {
			if (gen !== generation) return
			connected.value = true
			connecting.value = false
			error.value = null
			backoff = RECONNECT_MIN_MS
			// The server forgets per-connection things; re-seed it.
			for (const [topic, data] of latest) send({type: 'state', topic, data})
			serverFiles = null
			connectedHook.trigger()
			scheduleSync()
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
					peers.value = Array.isArray(msg.peers) ? msg.peers : []
					break
				case 'peer':
					if (msg.online) {
						if (!peers.value.includes(msg.id)) peers.value = [...peers.value, msg.id]
					} else {
						peers.value = peers.value.filter(p => p !== msg.id)
					}
					peerHook.trigger({id: msg.id, online: !!msg.online})
					break
				case 'signal':
					signalHook.trigger({from: msg.from, data: msg.data})
					break
				case 'control':
					if (typeof msg.topic !== 'string') break
					lastControl.value = {topic: msg.topic, from: String(msg.from ?? ''), t: Date.now()}
					controlHandlers.get(msg.topic)?.forEach(h => {
						try {
							h(msg.data, String(msg.from ?? ''))
						} catch (e) {
							// eslint-disable-next-line no-console
							console.error(`relay control ${msg.topic}:`, e)
						}
					})
					break
			}
		}
		socket.onerror = () => {
			if (gen !== generation) return
			error.value = 'Relay unreachable'
		}
		socket.onclose = ev => {
			if (gen !== generation) return
			ws = null
			connected.value = false
			connecting.value = false
			peers.value = []
			closeAllPeers()
			if (ev.code === 4000) error.value = 'Replaced by another shooting machine'
			scheduleReconnect()
		}
	}

	function disconnect(final = true) {
		if (retryTimer) {
			clearTimeout(retryTimer)
			retryTimer = null
		}
		generation++
		if (ws) {
			try {
				ws.close()
			} catch {
				// ignore
			}
			ws = null
		}
		connected.value = false
		connecting.value = false
		peers.value = []
		closeAllPeers()
		if (final) backoff = RECONNECT_MIN_MS
	}

	function send(msg: unknown) {
		if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
	}

	//--------------------------------------------------------------------------
	// Publish

	const latest = new Map<string, unknown>()
	const throttled = new Map<string, {timer: ReturnType<typeof setTimeout>; data: unknown}>()

	/** Send the latest value of a topic (kept and replayed by the server). */
	function publish(topic: string, data: unknown) {
		latest.set(topic, data)
		send({type: 'state', topic, data})
	}

	/** Like publish, but at most once per `ms` per topic (last value wins). */
	function publishThrottled(topic: string, data: unknown, ms = 100) {
		const t = throttled.get(topic)
		if (t) {
			t.data = data
			return
		}
		publish(topic, data)
		throttled.set(topic, {
			data: undefined,
			timer: setTimeout(() => {
				const entry = throttled.get(topic)
				throttled.delete(topic)
				if (entry && entry.data !== undefined) publish(topic, entry.data)
			}, ms),
		})
	}

	function signal(to: string, data: unknown) {
		send({type: 'signal', to, data})
	}

	/**
	 * Receive control messages of a topic sent by a `role=control` client
	 * (Houdini). Returns the unsubscribe function.
	 */
	function onControl(topic: string, handler: (data: any, from: string) => void) {
		let set = controlHandlers.get(topic)
		if (!set) controlHandlers.set(topic, (set = new Set()))
		set.add(handler)
		return () => {
			set.delete(handler)
		}
	}

	//--------------------------------------------------------------------------
	// Display copy: push what changed

	const extraProviders: ExtraFilesProvider[] = []

	/**
	 * Register a source of extra files the screens need besides the previews
	 * (e.g. previz/frames.json and its G-code). Called on every sync.
	 */
	function registerExtraFiles(fn: ExtraFilesProvider) {
		extraProviders.push(fn)
		scheduleSync()
		return () => {
			const i = extraProviders.indexOf(fn)
			if (i !== -1) extraProviders.splice(i, 1)
		}
	}

	/** rel → tag of files known to be on the server with that content. */
	const pushed = new Map<string, string>()
	let serverFiles: Map<string, ManifestEntry> | null = null
	let syncRequested = false
	let syncRunning = false

	project.onSaved(() => scheduleSync())

	function scheduleSync() {
		syncRequested = true
		if (!syncRunning) void runSync()
	}

	async function runSync() {
		if (syncRunning) return
		syncRunning = true
		try {
			while (syncRequested) {
				syncRequested = false
				if (!connected.value || !project.directoryHandle) break
				syncing.value = true
				try {
					await syncOnce(project.directoryHandle)
					syncError.value = null
					lastSyncAt.value = Date.now()
				} catch (e) {
					syncError.value = e instanceof Error ? e.message : String(e)
					// Try again on the next save / reconnect rather than spinning.
					syncRequested = false
				}
			}
		} finally {
			syncing.value = false
			pending.value = 0
			syncRunning = false
		}
	}

	async function fetchManifest(): Promise<Map<string, ManifestEntry>> {
		const res = await fetch(`${httpBase.value}/api/manifest`, {
			headers: headers(),
			cache: 'no-store',
		})
		if (!res.ok) throw new Error(`manifest ${res.status}`)
		const json = (await res.json()) as {files: Record<string, ManifestEntry>}
		return new Map(Object.entries(json.files ?? {}))
	}

	async function getFile(dir: FileSystemDirectoryHandle, rel: string): Promise<File | null> {
		try {
			const parts = rel.split('/').filter(Boolean)
			let d = dir
			for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p)
			const h = await d.getFileHandle(parts[parts.length - 1])
			return await h.getFile()
		} catch {
			return null
		}
	}

	async function put(rel: string, body: Blob, mtime: number): Promise<ManifestEntry> {
		const encoded = rel.split('/').map(encodeURIComponent).join('/')
		const res = await fetch(`${httpBase.value}/api/file/${encoded}`, {
			method: 'PUT',
			headers: {...headers(), 'X-Mtime': String(Math.round(mtime))},
			body,
		})
		if (!res.ok) throw new Error(`PUT ${rel}: ${res.status}`)
		pushedBytes.value += body.size
		return (await res.json()) as ManifestEntry
	}

	/** Everything the screens need, from the live project (asset ids). */
	async function wantedFiles(): Promise<WantedFile[]> {
		const out: WantedFile[] = []
		const seen = new Set<string>()
		const add = (rel: string, tag: string) => {
			if (seen.has(rel)) return
			seen.add(rel)
			out.push({rel, tag})
		}
		for (const koma of project.komas) {
			for (const shot of koma?.shots ?? []) {
				if (!shot?.lv) continue
				const name = getAssetFilename(shot.lv)
				if (name) add(name, shot.lv)
			}
		}
		for (const t of project.trash) {
			const id = t.shot?.lv
			if (!id) continue
			const name = getAssetFilename(id)
			if (name) add(`${TRASH_DIR}/${name}`, id)
		}
		for (const provider of extraProviders) {
			try {
				for (const f of await provider()) add(f.rel, f.tag)
			} catch {
				// a provider that can't list right now just contributes nothing
			}
		}
		return out
	}

	async function syncOnce(dir: FileSystemDirectoryHandle) {
		serverFiles ??= await fetchManifest()
		const server = serverFiles
		const wanted = (await wantedFiles()).filter(f => pushed.get(f.rel) !== f.tag)
		pending.value = wanted.length + 1

		const queue = [...wanted]
		await Promise.all(
			Array.from({length: PUSH_CONCURRENCY}, async () => {
				for (;;) {
					const w = queue.shift()
					if (!w) return
					if (!connected.value) throw new Error('Relay disconnected')
					try {
						const file = await getFile(dir, w.rel)
						if (!file) continue // not on disk (yet) — the next save will bring it
						const have = server.get(w.rel)
						if (have && have.size === file.size && have.mtime === Math.round(file.lastModified)) {
							pushed.set(w.rel, w.tag)
							continue
						}
						const info = await put(w.rel, file, file.lastModified)
						server.set(w.rel, info)
						pushed.set(w.rel, w.tag)
					} finally {
						pending.value = Math.max(0, pending.value - 1)
					}
				}
			})
		)

		// project.json last: what it references is now on the server.
		const json = await getFile(dir, 'project.json')
		if (json) {
			const info = await put('project.json', json, json.lastModified)
			server.set('project.json', info)
		}
		pending.value = 0
	}

	//--------------------------------------------------------------------------
	// Live view over WebRTC (one peer connection per screen that asked)

	const liveStream = shallowRef<MediaStream | null>(null)
	const pcs = new Map<string, {pc: RTCPeerConnection; sender: RTCRtpSender}>()
	const wanting = new Set<string>()
	/** Screens currently receiving the live view. */
	const liveViewers = ref(0)

	/** The camera's live view stream (or null while it is off). */
	function setLiveStream(stream: MediaStream | null) {
		liveStream.value = stream
	}

	function liveTrack(): MediaStreamTrack | null {
		return liveStream.value?.getVideoTracks()[0] ?? null
	}

	async function offerTo(id: string) {
		const track = liveTrack()
		if (!track || pcs.has(id)) return
		const pc = new RTCPeerConnection({iceServers: []})
		track.contentHint = 'detail'
		const sender = pc.addTrack(track, liveStream.value!)
		pcs.set(id, {pc, sender})
		liveViewers.value = pcs.size
		try {
			const params = sender.getParameters()
			params.degradationPreference = 'maintain-resolution'
			params.encodings = params.encodings?.length ? params.encodings : [{}]
			params.encodings[0].maxBitrate = LIVE_MAX_BITRATE
			await sender.setParameters(params)
		} catch {
			// best effort
		}
		pc.onicecandidate = ev => {
			if (ev.candidate) signal(id, {kind: 'ice', candidate: ev.candidate.toJSON()})
		}
		pc.onconnectionstatechange = () => {
			if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
				closePeer(id)
				// The screen will ask again if it is still there.
			}
		}
		try {
			const offer = await pc.createOffer()
			await pc.setLocalDescription(offer)
			signal(id, {kind: 'offer', sdp: pc.localDescription})
		} catch (e) {
			closePeer(id)
			error.value = `WebRTC offer failed: ${e instanceof Error ? e.message : String(e)}`
		}
	}

	function closePeer(id: string) {
		const p = pcs.get(id)
		if (!p) return
		pcs.delete(id)
		liveViewers.value = pcs.size
		try {
			p.pc.close()
		} catch {
			// ignore
		}
	}

	function closeAllPeers() {
		for (const id of [...pcs.keys()]) closePeer(id)
		wanting.clear()
	}

	signalHook.on(async ({from, data}) => {
		if (!data || typeof data !== 'object') return
		switch (data.kind) {
			case 'want-live':
				wanting.add(from)
				void offerTo(from)
				break
			case 'answer': {
				const p = pcs.get(from)
				if (p) await p.pc.setRemoteDescription(data.sdp).catch(() => closePeer(from))
				break
			}
			case 'ice': {
				const p = pcs.get(from)
				if (p && data.candidate) await p.pc.addIceCandidate(data.candidate).catch(() => {})
				break
			}
			case 'bye':
				wanting.delete(from)
				closePeer(from)
				break
		}
	})

	peerHook.on(({id, online}) => {
		if (!online) {
			wanting.delete(id)
			closePeer(id)
		}
	})

	// Tethr hands out a fresh MediaStream each time the live view (re)starts:
	// swap the track into every open connection, and offer to screens that
	// asked while there was nothing to send.
	watch(liveStream, stream => {
		const track = stream?.getVideoTracks()[0] ?? null
		if (track) track.contentHint = 'detail'
		for (const {sender} of pcs.values()) void sender.replaceTrack(track).catch(() => {})
		if (track) for (const id of wanting) void offerTo(id)
	})

	// Last: the immediate watch below connects (and runs a sync), which touches
	// everything declared above.
	watch(
		[url, token],
		() => {
			pushed.clear()
			serverFiles = null
			error.value = null
			syncError.value = null
			backoff = RECONNECT_MIN_MS
			connect()
		},
		{immediate: true}
	)

	// A laptop woken from sleep: don't wait for the backoff.
	const visibility = useDocumentVisibility()
	watch(visibility, v => {
		if (v === 'visible' && enabled.value && !connected.value) {
			backoff = RECONNECT_MIN_MS
			connect()
		}
	})

	return {
		url,
		token,
		enabled,
		connected: readonly(connected),
		connecting: readonly(connecting),
		error: readonly(error),
		peers: readonly(peers),
		syncing: readonly(syncing),
		pending: readonly(pending),
		lastSyncAt: readonly(lastSyncAt),
		syncError: readonly(syncError),
		pushedBytes: readonly(pushedBytes),
		liveStream: readonly(liveStream),
		liveViewers: readonly(liveViewers),
		connect,
		disconnect,
		syncNow: scheduleSync,
		publish,
		publishThrottled,
		onControl,
		lastControl: readonly(lastControl),
		registerExtraFiles,
		setLiveStream,
		onConnected: connectedHook.on,
	}
})
