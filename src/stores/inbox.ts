/**
 * The project's inbox: how anything outside koma changes an open project.
 *
 * koma holds the project in memory and autosaves the whole of project.json,
 * so an outside edit of that file is lost on the next save (and never seen by
 * the running app). Instead, an outside writer — a script, Houdini, Claude —
 * drops a *patch* into the project's `_inbox/` folder. koma applies it to the
 * live project and the normal autosave persists it: koma stays the only
 * writer of project.json, and a patch dropped while koma is closed simply
 * waits for the next time the project is open.
 *
 *   _inbox/<name>.json            waiting (write to a temp name, then rename)
 *   _inbox/applied/<name>.json    the patch + `result`, once applied and saved
 *   _inbox/rejected/<name>.json   the patch + `result.error`, nothing applied
 *
 * Patch:
 *   {
 *     "version": 1,
 *     "note": "what this is, shown in the title bar",
 *     "onConflict": "reject",        // or "skip" | "overwrite" (default reject)
 *     "ops": [{"op": "<name>", …}, …]
 *   }
 *
 * A patch is all-or-nothing: every op is checked against the project first,
 * and if one cannot be applied nothing is. An op that would replace existing
 * data is a *conflict*, resolved by `onConflict` (per op, else the patch's):
 * reject the patch, skip that op, or overwrite. What each op replaced is
 * kept in the result (`before`), which is what a revert patch is written
 * from — inbox edits are not on the undo stack.
 *
 * The ops themselves are registered by whoever owns the data (`registerOp`).
 */

import {defineStore} from 'pinia'
import {ref} from 'vue'

import {useProjectStore} from './project'

export const INBOX_DIR = '_inbox'
const APPLIED_DIR = 'applied'
const REJECTED_DIR = 'rejected'
const POLL_MS = 2000
/** A patch that still doesn't parse after this many polls is rejected. */
const PARSE_ATTEMPTS = 5
const SAVE_TIMEOUT_MS = 20000

export type InboxConflictPolicy = 'reject' | 'skip' | 'overwrite'

export interface InboxPatch {
	version: number
	note?: string
	onConflict?: InboxConflictPolicy
	ops: InboxOp[]
}

export interface InboxOp {
	op: string
	onConflict?: InboxConflictPolicy
	[key: string]: unknown
}

/** Thrown by a handler when the op would replace something that is there. */
export class InboxConflict extends Error {}

/**
 * What applying one op will do, decided before anything changes. `apply`
 * must be synchronous and must not fail; it returns what it replaced.
 */
export interface InboxPrepared {
	apply: () => unknown
}

export interface InboxOpContext {
	root: FileSystemDirectoryHandle
	/** True when existing data may be replaced (`onConflict: overwrite`). */
	overwrite: boolean
}

/**
 * Check an op against the project and return how to apply it. Throw
 * `InboxConflict` if it would replace existing data and `ctx.overwrite` is
 * false, any other error if the op is invalid. Must not change the project.
 */
export type InboxOpHandler = (
	op: InboxOp,
	ctx: InboxOpContext
) => Promise<InboxPrepared> | InboxPrepared

export interface InboxOpResult {
	status: 'applied' | 'skipped'
	message?: string
	before?: unknown
}

export interface InboxEntry {
	name: string
	note: string
	status: 'applied' | 'rejected'
	at: number
	applied: number
	skipped: number
	total: number
	error?: string
	messages: string[]
}

const handlers = new Map<string, InboxOpHandler>()

/** Register the handler of an op name. Later registrations replace earlier. */
export function registerInboxOp(name: string, handler: InboxOpHandler) {
	handlers.set(name, handler)
}

export const useInboxStore = defineStore('inbox', () => {
	const project = useProjectStore()

	/** This session's patches, newest first. */
	const entries = ref<InboxEntry[]>([])
	/** Entries added since the list was last looked at. */
	const unseen = ref(0)

	// Names taken care of in this session — applied in memory even if the
	// file is still waiting for the save before it is moved.
	const handled = new Set<string>()
	const parseFailures = new Map<string, number>()
	let scanning = false

	function record(entry: InboxEntry) {
		entries.value = [entry, ...entries.value].slice(0, 30)
		unseen.value += 1
	}

	async function inboxDir(root: FileSystemDirectoryHandle) {
		try {
			return await root.getDirectoryHandle(INBOX_DIR)
		} catch {
			return null
		}
	}

	async function writeJson(dir: FileSystemDirectoryHandle, name: string, data: unknown) {
		const handle = await dir.getFileHandle(name, {create: true})
		const w = await handle.createWritable()
		try {
			await w.write(JSON.stringify(data, null, '\t'))
		} finally {
			await w.close()
		}
	}

	/** Move a patch out of the inbox, with its result attached. */
	async function file(
		inbox: FileSystemDirectoryHandle,
		name: string,
		into: string,
		patch: unknown,
		result: unknown
	) {
		const dir = await inbox.getDirectoryHandle(into, {create: true})
		const body =
			patch && typeof patch === 'object' && !Array.isArray(patch)
				? {...(patch as object), result}
				: {patch, result}
		await writeJson(dir, name, body)
		await inbox.removeEntry(name)
	}

	/** Resolves once the project has been saved (or the wait times out). */
	function nextSave(): Promise<boolean> {
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				off()
				resolve(false)
			}, SAVE_TIMEOUT_MS)
			const {off} = project.onSaved(() => {
				clearTimeout(timer)
				off()
				resolve(true)
			})
		})
	}

	async function reject(
		inbox: FileSystemDirectoryHandle,
		name: string,
		patch: unknown,
		error: string,
		total = 0
	) {
		handled.add(name)
		const at = Date.now()
		await file(inbox, name, REJECTED_DIR, patch, {
			status: 'rejected',
			at: new Date(at).toISOString(),
			error,
		}).catch(() => {})
		record({
			name,
			note: (patch as InboxPatch | null)?.note ?? '',
			status: 'rejected',
			at,
			applied: 0,
			skipped: 0,
			total,
			error,
			messages: [],
		})
	}

	async function process(
		root: FileSystemDirectoryHandle,
		inbox: FileSystemDirectoryHandle,
		name: string,
		text: string
	) {
		let patch: InboxPatch
		try {
			patch = JSON.parse(text)
		} catch (e) {
			// Probably half-written (Dropbox, or a writer that didn't rename):
			// leave it for the next polls before giving up.
			const n = (parseFailures.get(name) ?? 0) + 1
			parseFailures.set(name, n)
			if (n >= PARSE_ATTEMPTS) {
				await reject(inbox, name, text, `Not valid JSON: ${e instanceof Error ? e.message : e}`)
			}
			return
		}
		parseFailures.delete(name)

		if (!patch || typeof patch !== 'object' || !Array.isArray(patch.ops)) {
			await reject(inbox, name, patch, 'Not a patch: "ops" must be an array')
			return
		}
		if (patch.version !== 1) {
			await reject(inbox, name, patch, `Unsupported patch version ${patch.version}`, patch.ops.length)
			return
		}

		// Check every op before changing anything.
		const prepared: (InboxPrepared | {skip: string})[] = []
		for (const [i, op] of patch.ops.entries()) {
			const where = `op ${i} (${op?.op ?? '?'})`
			const handler = op && typeof op.op === 'string' ? handlers.get(op.op) : undefined
			if (!handler) {
				await reject(inbox, name, patch, `${where}: unknown op`, patch.ops.length)
				return
			}
			const policy = op.onConflict ?? patch.onConflict ?? 'reject'
			try {
				prepared.push(await handler(op, {root, overwrite: policy === 'overwrite'}))
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e)
				if (e instanceof InboxConflict && policy === 'skip') {
					prepared.push({skip: message})
					continue
				}
				await reject(inbox, name, patch, `${where}: ${message}`, patch.ops.length)
				return
			}
		}
		// The project may have been switched while the ops were being checked.
		if (project.directoryHandle !== root || project.isOpening) return

		const results: InboxOpResult[] = prepared.map(p =>
			'skip' in p
				? {status: 'skipped', message: p.skip}
				: {status: 'applied', before: p.apply()}
		)
		handled.add(name)
		const applied = results.filter(r => r.status === 'applied').length
		const at = Date.now()
		record({
			name,
			note: patch.note ?? '',
			status: 'applied',
			at,
			applied,
			skipped: results.length - applied,
			total: results.length,
			messages: results.flatMap(r => (r.message ? [r.message] : [])),
		})

		// Only file the patch as applied once project.json holds it: if koma
		// goes away before the save, the patch is still waiting next time.
		const saved = applied === 0 ? true : await nextSave()
		if (project.directoryHandle !== root) return
		await file(inbox, name, APPLIED_DIR, patch, {
			status: 'applied',
			at: new Date(at).toISOString(),
			saved,
			ops: results,
		}).catch(() => {})
	}

	async function scan() {
		if (scanning || project.isOpening) return
		const root = project.directoryHandle
		if (!root) return
		scanning = true
		try {
			const inbox = await inboxDir(root)
			if (!inbox) return
			const names: string[] = []
			for await (const [name, handle] of (inbox as any).entries() as AsyncIterable<
				[string, FileSystemHandle]
			>) {
				if (handle.kind === 'file' && name.endsWith('.json') && !name.startsWith('.')) {
					names.push(name)
				}
			}
			names.sort((a, b) => a.localeCompare(b, undefined, {numeric: true}))
			for (const name of names) {
				if (handled.has(name)) continue
				if (project.directoryHandle !== root) return
				let text: string
				try {
					text = await (await (await inbox.getFileHandle(name)).getFile()).text()
				} catch {
					continue
				}
				await process(root, inbox, name, text)
			}
		} catch (e) {
			// eslint-disable-next-line no-console
			console.error('[inbox]', e)
		} finally {
			scanning = false
		}
	}

	setInterval(() => void scan(), POLL_MS)

	function markSeen() {
		unseen.value = 0
	}

	return {entries, unseen, markSeen, scan}
})
