/**
 * Call one of koma's tools from a script, through the aux tools bridge
 * (dev_modules/aux-manager/lib/toolsBridge.js — running with `yarn dev`,
 * `yarn aux` or inside the desktop app). koma must be open with the project.
 *
 *   const {callTool} = await import('./lib/komaTools.mjs')
 *   const outcome = await callTool('apply_patch', {note, onConflict, ops})
 *
 * Throws with the bridge's / tool's message when the call fails.
 */
export const TOOLS_URL = process.env.KOMA_TOOLS_URL ?? 'http://127.0.0.1:8090'

export async function callTool(name, args = {}, {url = TOOLS_URL} = {}) {
	let res
	try {
		res = await fetch(`${url}/call`, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify({name, arguments: args}),
		})
	} catch (e) {
		throw new Error(`no tools bridge at ${url} — run yarn dev / yarn aux, or open the desktop app (${e.message})`)
	}
	const body = await res.json().catch(() => ({ok: false, error: `${res.status} ${res.statusText}`}))
	if (!body.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`)
	return body.result
}

/** One-line summary of an `apply_patch` outcome. */
export function describeOutcome(outcome) {
	if (!outcome) return 'nothing'
	if (outcome.status !== 'applied') return `rejected: ${outcome.error}`
	return outcome.skipped ? `${outcome.applied} applied, ${outcome.skipped} skipped` : `${outcome.applied} applied`
}
