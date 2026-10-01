#!/usr/bin/env node
/**
 * What is wrong with the exhibit screens: asks the relay and the Chrome that
 * kiosk.mjs started what they are doing, reloads each window and prints the
 * errors it hits on the way up. Changes nothing else.
 *
 *   node diagnose.mjs            (same KOMA_* variables as kiosk.mjs)
 */
import {setTimeout as sleep} from 'node:timers/promises'

const env = process.env
const RELAY = `http://localhost:${env.KOMA_RELAY_PORT || 7777}`
const DEBUG_PORT = env.KOMA_EXHIBIT_DEBUG_PORT || 9333
const WATCH_MS = 8000

const line = (...a) => console.log(...a)

async function get(url) {
	try {
		const res = await fetch(url)
		return {status: res.status, text: await res.text()}
	} catch (e) {
		return {status: 0, text: String(e?.cause?.code ?? e?.message ?? e)}
	}
}

//------------------------------------------------------------------------------
line(`node ${process.version}`)
line(`\n== relay ${RELAY}`)
const status = await get(`${RELAY}/api/status`)
line(`/api/status          ${status.status || 'NOT REACHABLE'}  ${status.text.slice(0, 200)}`)
const page = await get(`${RELAY}/exhibit.html`)
line(`/exhibit.html        ${page.status || 'NOT REACHABLE'}  ${page.text.length} bytes`)
const project = await get(`${RELAY}/project/project.json`)
line(`/project/project.json ${project.status || 'NOT REACHABLE'}  ${project.text.length} bytes`)

//------------------------------------------------------------------------------
line(`\n== Chrome (DevTools port ${DEBUG_PORT})`)
const version = await get(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
if (version.status !== 200) {
	line(`not reachable (${version.text}): the Chrome started by kiosk.mjs is not running`)
	process.exit(1)
}
const info = JSON.parse(version.text)
line(info.Browser)

const ws = new WebSocket(info.webSocketDebuggerUrl)
const pending = new Map()
const events = []
let id = 0
ws.onmessage = ev => {
	const msg = JSON.parse(ev.data)
	if (msg.id) pending.get(msg.id)?.(msg)
	else events.push(msg)
}
await new Promise((res, rej) => {
	ws.onopen = res
	ws.onerror = () => rej(new Error('cannot connect to Chrome'))
})
function send(method, params = {}, sessionId) {
	return new Promise(res => {
		const n = ++id
		const timer = setTimeout(() => res({error: {message: 'no answer'}}), 10_000)
		pending.set(n, msg => {
			clearTimeout(timer)
			res(msg)
		})
		ws.send(JSON.stringify({id: n, method, params, sessionId}))
	})
}

const STATE = `JSON.stringify({
	readyState: document.readyState,
	visibility: document.visibilityState,
	background: getComputedStyle(document.body).backgroundColor,
	elements: document.querySelectorAll('body *').length,
	videos: [...document.querySelectorAll('video')].map(v => [v.videoWidth, v.videoHeight, v.paused, v.readyState]),
	text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300),
	sw: !!navigator.serviceWorker?.controller,
})`

async function state(sessionId) {
	const r = await send('Runtime.evaluate', {expression: STATE, returnByValue: true}, sessionId)
	return r.result?.result?.value ?? `(${r.error?.message ?? r.result?.exceptionDetails?.text ?? 'no answer'})`
}

const {result} = await send('Target.getTargets')
const pages = result.targetInfos.filter(t => t.type === 'page')
line(`${pages.length} window(s)`)

for (const t of pages) {
	line(`\n-- ${t.url}   "${t.title}"`)
	const w = await send('Browser.getWindowForTarget', {targetId: t.targetId})
	line(`window  ${JSON.stringify(w.result?.bounds ?? w.error)}`)
	const {sessionId} = (await send('Target.attachToTarget', {targetId: t.targetId, flatten: true})).result
	line(`before  ${await state(sessionId)}`)

	await send('Runtime.enable', {}, sessionId)
	await send('Log.enable', {}, sessionId)
	await send('Page.enable', {}, sessionId)
	events.length = 0
	await send('Page.reload', {}, sessionId)
	await sleep(WATCH_MS)

	const seen = new Set()
	for (const e of events) {
		if (e.sessionId !== sessionId) continue
		let text = null
		if (e.method === 'Runtime.exceptionThrown') {
			const d = e.params.exceptionDetails
			text = `exception: ${d.exception?.description ?? d.text} (${d.url ?? ''}:${d.lineNumber ?? ''})`
		} else if (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) {
			text = `console.${e.params.type}: ${e.params.args.map(a => a.value ?? a.description ?? a.type).join(' ')}`
		} else if (e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level)) {
			text = `${e.params.entry.source} ${e.params.entry.level}: ${e.params.entry.text} ${e.params.entry.url ?? ''}`
		}
		if (text && !seen.has(text)) {
			seen.add(text)
			line(`  ${text.slice(0, 400)}`)
		}
	}
	if (seen.size === 0) line('  (no errors while loading)')
	line(`after   ${await state(sessionId)}`)
	await send('Target.detachFromTarget', {sessionId})
}

ws.close()
