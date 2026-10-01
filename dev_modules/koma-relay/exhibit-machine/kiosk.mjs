#!/usr/bin/env node
/**
 * Puts the exhibit screens on the displays of this machine: one Chrome, one
 * fullscreen window per display (screen A on the first, screen B on the
 * second), and keeps them there — a display that shows up late (a projector
 * switched on after the Mac), a window that left fullscreen or was closed.
 *
 * Both windows live in one Chrome profile: screen B follows screen A over a
 * BroadcastChannel, which does not cross profiles. Chrome's command line can
 * only place the first window, so the windows are placed over the DevTools
 * protocol instead (a local port; no macOS permission prompts, nothing to
 * click).
 *
 * Runs in the foreground and exits when Chrome does; launchd restarts it
 * (install-launchd.sh --kiosk). Needs Node 22+ (the built-in WebSocket).
 *
 *   KOMA_EXHIBIT_SCREENS   what goes on each display, displays taken left to
 *                          right: a | b | ab (both, side by side) | - (leave
 *                          that display alone). Default "a,b"; "b,a" swaps.
 *   KOMA_RELAY_PORT        the relay that serves the page (default 7777)
 *   KOMA_EXHIBIT_URL       the page, if not http://localhost:<port>/exhibit.html
 *   KOMA_EXHIBIT_PROFILE   Chrome profile folder
 *   KOMA_EXHIBIT_CHROME    Chrome binary
 *   KOMA_EXHIBIT_DEBUG_PORT  DevTools port (default 9333, localhost only)
 */
import {spawn} from 'node:child_process'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as sleep} from 'node:timers/promises'

const env = process.env
const PAGE = env.KOMA_EXHIBIT_URL || `http://localhost:${env.KOMA_RELAY_PORT || 7777}/exhibit.html`
const SCREENS = (env.KOMA_EXHIBIT_SCREENS || 'a,b').split(',').map(s => s.trim().toLowerCase())
const CHROME =
	env.KOMA_EXHIBIT_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PROFILE =
	env.KOMA_EXHIBIT_PROFILE || join(homedir(), 'Library/Application Support/koma-exhibit-chrome')
const DEBUG_PORT = env.KOMA_EXHIBIT_DEBUG_PORT || 9333

/** How often the windows are checked against the displays. */
const CHECK_MS = 5000
/** How long the first placement waits for every display to show up. */
const DISPLAYS_WAIT_MS = 20_000
const CDP_TIMEOUT_MS = 10_000

const TOKENS = SCREENS.filter(s => s !== '-')
if (
	TOKENS.length === 0 ||
	TOKENS.some(s => !['a', 'b', 'ab'].includes(s)) ||
	new Set(TOKENS).size !== TOKENS.length
) {
	console.error(`KOMA_EXHIBIT_SCREENS="${SCREENS.join(',')}": use a, b, ab or -, each screen once`)
	process.exit(2)
}
if (typeof WebSocket === 'undefined') {
	console.error(`Node ${process.version} has no WebSocket: Node 22 or later is needed`)
	process.exit(2)
}

function log(...args) {
	console.log(new Date().toLocaleString('ja-JP', {hour12: false}), ...args)
}

const urlOf = token => `${PAGE}?screen=${token}`

/** Which exhibit screen a page shows (null: not the exhibit page). */
function screenOf(url) {
	try {
		const u = new URL(url)
		return u.origin + u.pathname === PAGE ? (u.searchParams.get('screen') ?? 'ab') : null
	} catch {
		return null
	}
}

//------------------------------------------------------------------------------
// The page has to be there before Chrome opens it (the relay starts at login too)

async function waitForPage() {
	for (let n = 0; ; n++) {
		try {
			if ((await fetch(PAGE)).ok) return
		} catch {
			// not up yet
		}
		if (n % 15 === 0) log(`waiting for ${PAGE}`)
		await sleep(2000)
	}
}

//------------------------------------------------------------------------------
// Chrome and its DevTools connection

async function debuggerUrl() {
	try {
		const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
		return (await res.json()).webSocketDebuggerUrl ?? null
	} catch {
		return null
	}
}

let chrome = null

async function launchChrome() {
	chrome = spawn(
		CHROME,
		[
			`--user-data-dir=${PROFILE}`,
			`--remote-debugging-port=${DEBUG_PORT}`,
			// No toolbar, no "press Esc to leave fullscreen", fullscreen from the start.
			'--kiosk',
			'--no-first-run',
			'--no-default-browser-check',
			'--noerrdialogs',
			'--disable-session-crashed-bubble',
			'--hide-crash-restore-bubble',
			'--disable-features=Translate',
			// Screen A's sound starts without a click.
			'--autoplay-policy=no-user-gesture-required',
			// Only one window has the focus; the other one must not slow down.
			'--disable-renderer-backgrounding',
			'--disable-backgrounding-occluded-windows',
			urlOf(TOKENS[0]),
		],
		{stdio: 'ignore'}
	)
	chrome.on('exit', code => {
		log(`Chrome exited (${code})`)
		process.exit(code ?? 1)
	})
	// The displays stay awake for as long as this Chrome runs.
	spawn('caffeinate', ['-dis', '-w', String(chrome.pid)], {stdio: 'ignore'}).on('error', () => {})

	for (let i = 0; i < 60; i++) {
		const url = await debuggerUrl()
		if (url) return url
		await sleep(500)
	}
	throw new Error(`Chrome did not open its DevTools port ${DEBUG_PORT}`)
}

function connect(url) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url)
		const pending = new Map()
		let id = 0
		function send(method, params = {}, sessionId) {
			return new Promise((res, rej) => {
				const n = ++id
				const timer = setTimeout(() => {
					pending.delete(n)
					rej(new Error(`${method}: no answer`))
				}, CDP_TIMEOUT_MS)
				pending.set(n, {res, rej, timer, method})
				ws.send(JSON.stringify({id: n, method, params, sessionId}))
			})
		}
		ws.onopen = () => resolve({send})
		ws.onerror = () => reject(new Error('cannot connect to Chrome'))
		ws.onmessage = ev => {
			const msg = JSON.parse(ev.data)
			const p = pending.get(msg.id)
			if (!p) return
			pending.delete(msg.id)
			clearTimeout(p.timer)
			if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`))
			else p.res(msg.result)
		}
		ws.onclose = () => {
			log('lost the connection to Chrome')
			shutdown(1)
		}
	})
}

function shutdown(code) {
	if (chrome && chrome.exitCode === null) chrome.kill()
	process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

//------------------------------------------------------------------------------
// Windows

/** One window per screen: token → targetId. Opens the missing ones, closes doubles. */
async function ensureWindows(cdp) {
	const {targetInfos} = await cdp.send('Target.getTargets')
	const windows = new Map()
	for (const t of targetInfos) {
		if (t.type !== 'page') continue
		const token = screenOf(t.url)
		if (!token || !TOKENS.includes(token)) continue
		if (windows.has(token)) await cdp.send('Target.closeTarget', {targetId: t.targetId})
		else windows.set(token, t.targetId)
	}
	for (const token of TOKENS) {
		if (windows.has(token)) continue
		const {targetId} = await cdp.send('Target.createTarget', {url: urlOf(token), newWindow: true})
		windows.set(token, targetId)
		log(`opened screen ${token.toUpperCase()}`)
	}
	return windows
}

/** The displays as a page sees them, left to right (then top to bottom). */
async function displays(cdp, targetId) {
	const {sessionId} = await cdp.send('Target.attachToTarget', {targetId, flatten: true})
	try {
		const {result, exceptionDetails} = await cdp.send(
			'Runtime.evaluate',
			{
				expression: `getScreenDetails().then(d => JSON.stringify(
					d.screens.map(s => ({left: s.left, top: s.top, width: s.width, height: s.height}))))`,
				awaitPromise: true,
				returnByValue: true,
			},
			sessionId
		)
		if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'getScreenDetails failed')
		return JSON.parse(result.value).sort((p, q) => p.left - q.left || p.top - q.top)
	} finally {
		await cdp.send('Target.detachFromTarget', {sessionId}).catch(() => {})
	}
}

const inside = (b, d) => {
	const x = b.left + b.width / 2
	const y = b.top + b.height / 2
	return x >= d.left && x < d.left + d.width && y >= d.top && y < d.top + d.height
}

async function waitForState(cdp, windowId, state) {
	for (let i = 0; i < 20; i++) {
		const {bounds} = await cdp.send('Browser.getWindowBounds', {windowId})
		if (bounds.windowState === state) return true
		await sleep(250)
	}
	return false
}

/** Fullscreen on display `d`. Returns whether the window had to be moved. */
async function place(cdp, targetId, d) {
	const {windowId, bounds} = await cdp.send('Browser.getWindowForTarget', {targetId})
	if (bounds.windowState === 'fullscreen' && inside(bounds, d)) return false
	// A fullscreen window can't be moved, and a move can't be combined with a state.
	if (bounds.windowState !== 'normal') {
		await cdp.send('Browser.setWindowBounds', {windowId, bounds: {windowState: 'normal'}})
		await waitForState(cdp, windowId, 'normal')
		await sleep(500)
	}
	const margin = 80
	await cdp.send('Browser.setWindowBounds', {
		windowId,
		bounds: {
			left: d.left + margin,
			top: d.top + margin,
			width: Math.max(400, d.width - margin * 2),
			height: Math.max(300, d.height - margin * 2),
		},
	})
	await sleep(500)
	await cdp.send('Browser.setWindowBounds', {windowId, bounds: {windowState: 'fullscreen'}})
	await waitForState(cdp, windowId, 'fullscreen')
	return true
}

//------------------------------------------------------------------------------

async function main() {
	log(`exhibit screens: ${SCREENS.join(', ')} (displays left to right) — ${PAGE}`)
	await waitForPage()

	let url = await debuggerUrl()
	if (url) log('Chrome is already running: taking over its windows')
	else url = await launchChrome()
	const cdp = await connect(url)
	// getScreenDetails() without the permission prompt.
	await cdp.send('Browser.grantPermissions', {
		origin: new URL(PAGE).origin,
		permissions: ['windowManagement'],
	})

	const started = Date.now()
	let lastSeen = ''
	for (;;) {
		try {
			const windows = await ensureWindows(cdp)
			const ds = await displays(cdp, windows.get(TOKENS[0]))
			const seen = ds.map(d => `${d.width}×${d.height}@${d.left},${d.top}`).join('  ')
			if (seen !== lastSeen) log(`${ds.length} display(s): ${seen}`)
			lastSeen = seen
			// At startup, give every display the time to show up before placing anything.
			if (ds.length >= SCREENS.length || Date.now() - started > DISPLAYS_WAIT_MS) {
				for (const [i, token] of SCREENS.entries()) {
					if (token === '-' || !ds[i]) continue
					if (await place(cdp, windows.get(token), ds[i])) {
						log(`screen ${token.toUpperCase()} → display ${i + 1}, fullscreen`)
					}
				}
			}
		} catch (e) {
			log(`${e?.message ?? e}`)
		}
		await sleep(CHECK_MS)
	}
}

main().catch(e => {
	log(`${e?.message ?? e}`)
	shutdown(1)
})
