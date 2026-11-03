/**
 * The project's inbox: how anything outside koma changes an open project.
 *
 * koma holds the project in memory and autosaves the whole of project.json,
 * so an outside edit of that file is lost on the next save (and never seen by
 * the running app). Instead, an outside writer — Claude Code, a script,
 * Houdini — sends a *patch*, which koma applies to the live project; the
 * normal autosave persists it, and koma stays the only writer of
 * project.json. Patches arrive over the aux tools bridge (stores/tools.ts:
 * every op is an MCP tool, `apply_patch` takes a whole patch) or the relay's
 * `inbox` control topic (addsub/stores/houdini.ts, Houdini's "Send Plans").
 * The `_inbox/` folder of patch files that koma used to poll is gone
 * (2026-10-23); a patch needs koma open.
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
 * The ops themselves are registered by whoever owns the data
 * (`registerInboxOp`), with a description and a JSON Schema that make them
 * tools.
 */

import {snake} from 'case'
import {defineStore} from 'pinia'
import {ref} from 'vue'

import {useProjectStore} from './project'
import {registerTool} from './tools'

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

/** What makes an op a tool: how it is described to an MCP client. */
export interface InboxOpInfo {
	description: string
	/** JSON Schema `properties` of the op's fields (`op` and `onConflict` are added). */
	properties: Record<string, unknown>
	required?: string[]
}

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

/** What became of a patch (sent back to whoever sent it). */
export type InboxOutcome =
	| {status: 'applied'; at: string; applied: number; skipped: number; total: number; ops: InboxOpResult[]}
	| {status: 'rejected'; at: string; error: string; total: number}

const handlers = new Map<string, InboxOpHandler>()

const ON_CONFLICT_SCHEMA = {
	type: 'string',
	enum: ['reject', 'skip', 'overwrite'],
	description:
		'What to do when the op would replace existing data: reject (default; the call fails and nothing changes), skip (leave that data alone), overwrite.',
}

/**
 * Register the handler of an op name. Later registrations replace earlier.
 * With `info`, the op is also a tool (the snake_case of its name) that
 * applies it as a one-op patch.
 */
export function registerInboxOp(name: string, handler: InboxOpHandler, info?: InboxOpInfo) {
	handlers.set(name, handler)
	if (!info) return
	registerTool({
		name: snake(name),
		description: info.description,
		inputSchema: {
			type: 'object',
			properties: {...info.properties, onConflict: ON_CONFLICT_SCHEMA},
			required: info.required ?? [],
			additionalProperties: false,
		},
		execute: async args => {
			const {onConflict, ...fields} = args
			const outcome = await useInboxStore().applyPatch(
				{version: 1, note: `${name} (tool)`, onConflict, ops: [{op: name, ...fields}]},
				`tool:${snake(name)}`
			)
			return toolResult(outcome)
		},
	})
}

/** Names of the registered ops (for the patch tool's description). */
export function inboxOpNames(): string[] {
	return [...handlers.keys()]
}

/** A patch outcome as a tool result: throws when it was rejected. */
function toolResult(outcome: InboxOutcome | null) {
	if (!outcome) {
		const project = useProjectStore()
		throw new Error(
			project.directoryHandle
				? 'the project is being opened — try again in a moment'
				: 'the project has no folder yet (save it first)'
		)
	}
	if (outcome.status === 'rejected') throw new Error(outcome.error)
	return outcome
}

export const useInboxStore = defineStore('inbox', () => {
	const project = useProjectStore()

	/** This session's patches, newest first. */
	const entries = ref<InboxEntry[]>([])
	/** Entries added since the list was last looked at. */
	const unseen = ref(0)

	function record(entry: InboxEntry) {
		entries.value = [entry, ...entries.value].slice(0, 30)
		unseen.value += 1
	}

	/**
	 * Check and apply one patch to the open project — the same all-or-nothing
	 * rules whichever way it came. Records the outcome in this session's
	 * list. Null when there is no project folder, or the project went away
	 * while the ops were being checked.
	 */
	async function applyPatch(patch: unknown, name: string): Promise<InboxOutcome | null> {
		const root = project.directoryHandle
		if (!root || project.isOpening) return null
		const at = new Date().toISOString()
		const rejected = (error: string, total = 0, note = ''): InboxOutcome => {
			record({name, note, status: 'rejected', at: Date.parse(at), applied: 0, skipped: 0, total, error, messages: []})
			return {status: 'rejected', at, error, total}
		}
		const p = patch as InboxPatch
		if (!p || typeof p !== 'object' || !Array.isArray(p.ops)) {
			return rejected('Not a patch: "ops" must be an array')
		}
		if (p.version !== 1) return rejected(`Unsupported patch version ${p.version}`, p.ops.length, p.note)

		// Check every op before changing anything.
		const prepared: (InboxPrepared | {skip: string})[] = []
		for (const [i, op] of p.ops.entries()) {
			const where = `op ${i} (${op?.op ?? '?'})`
			const handler = op && typeof op.op === 'string' ? handlers.get(op.op) : undefined
			if (!handler) return rejected(`${where}: unknown op`, p.ops.length, p.note)
			const policy = op.onConflict ?? p.onConflict ?? 'reject'
			try {
				prepared.push(await handler(op, {root, overwrite: policy === 'overwrite'}))
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e)
				if (e instanceof InboxConflict && policy === 'skip') {
					prepared.push({skip: message})
					continue
				}
				return rejected(`${where}: ${message}`, p.ops.length, p.note)
			}
		}
		// The project may have been switched while the ops were being checked.
		if (project.directoryHandle !== root || project.isOpening) return null

		const ops: InboxOpResult[] = prepared.map(pr =>
			'skip' in pr ? {status: 'skipped', message: pr.skip} : {status: 'applied', before: pr.apply()}
		)
		const applied = ops.filter(r => r.status === 'applied').length
		record({
			name,
			note: p.note ?? '',
			status: 'applied',
			at: Date.parse(at),
			applied,
			skipped: ops.length - applied,
			total: ops.length,
			messages: ops.flatMap(r => (r.message ? [r.message] : [])),
		})
		return {status: 'applied', at, applied, skipped: ops.length - applied, total: ops.length, ops}
	}

	function markSeen() {
		unseen.value = 0
	}

	registerTool({
		name: 'apply_patch',
		description:
			'Apply several ops to the open project at once, all-or-nothing: every op is checked first and if one cannot be applied nothing changes. ' +
			'Each op is an object {"op": "<name>", …fields} with the same fields as that op\'s tool; ' +
			'the ops are listed in `get_project`. "onConflict" (reject | skip | overwrite, default reject) applies to every op unless an op sets its own. ' +
			'Returns per-op results with what each replaced ("before"), from which a revert patch can be written — these edits are not on the undo stack.',
		inputSchema: {
			type: 'object',
			properties: {
				note: {type: 'string', description: 'What this patch is, shown in koma\'s title bar.'},
				onConflict: ON_CONFLICT_SCHEMA,
				ops: {
					type: 'array',
					items: {
						type: 'object',
						properties: {op: {type: 'string'}, onConflict: ON_CONFLICT_SCHEMA},
						required: ['op'],
						additionalProperties: true,
					},
					minItems: 1,
				},
			},
			required: ['ops'],
			additionalProperties: false,
		},
		execute: async args => toolResult(await applyPatch({version: 1, ...args}, `tool:apply_patch`)),
	})

	return {entries, unseen, markSeen, applyPatch}
})
