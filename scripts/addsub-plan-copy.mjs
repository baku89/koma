#!/usr/bin/env node
/**
 * Copy one layer's plans to another layer, lifted (addsub).
 *
 * For re-shooting a take after the block under the camera changed height:
 * every plan of the source layer is copied to the same frame of the target
 * layer with the rig's Y (and the stored camera pose's Y) moved by --dy mm.
 * Everything else (rotation, X/Z, camera configs incl. the normalised focus,
 * LED record, note) is kept as it is.
 *
 *   node scripts/addsub-plan-copy.mjs <project-dir> --from Test1018 --to "Test1018 +60" \
 *     --dy 60 [--frames 0-39] [--write] [--force]
 *
 * Layers are given by name or id; the target layer must already exist (make
 * it in koma: Layers › New Test Shot…). Without --write it only reports.
 * With --write it drops a patch into the project's _inbox/ (src/stores/inbox.ts)
 * — koma applies it to the open project within seconds, or when the project
 * is next opened, and files it under _inbox/applied/ or _inbox/rejected/.
 * project.json is never touched. Frames that already have a plan on the
 * target are refused unless --force (then replaced).
 */
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'

const argv = process.argv.slice(2)
const flags = {}
const positional = []
for (let i = 0; i < argv.length; i++) {
	const a = argv[i]
	if (a === '--write' || a === '--force') flags[a.slice(2)] = true
	else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i]
	else positional.push(a)
}

const projectDir = positional[0]
const dy = flags.dy === undefined ? 0 : Number(flags.dy)
if (!projectDir || !flags.from || !flags.to || !Number.isFinite(dy)) {
	console.error(
		'usage: addsub-plan-copy.mjs <project-dir> --from <layer> --to <layer> --dy MM [--frames A-B] [--write] [--force]'
	)
	process.exit(2)
}

const project = JSON.parse(await readFile(join(projectDir, 'project.json'), 'utf8'))
const layers = project.layers.filter(l => !l.deleted)

function findLayer(key) {
	const hit = layers.find(l => l.id === key) ?? layers.find(l => l.name === key)
	if (!hit) {
		throw new Error(
			`No layer "${key}". Layers: ${layers.map(l => `${l.name} (${l.id})`).join(', ')}`
		)
	}
	return hit
}

const from = findLayer(flags.from)
const to = findLayer(flags.to)
if (from.id === to.id) throw new Error('--from and --to are the same layer')

let range = null
if (flags.frames) {
	const m = /^(\d+)-(\d+)$/.exec(flags.frames)
	if (!m) throw new Error('--frames must be like 0-39')
	range = [Number(m[1]), Number(m[2])]
}

const source = project.addsub?.plan?.[from.id] ?? {}
const target = project.addsub?.plan?.[to.id] ?? {}
const frames = Object.keys(source)
	.map(Number)
	.filter(f => !range || (f >= range[0] && f <= range[1]))
	.sort((a, b) => a - b)
if (frames.length === 0) throw new Error(`Layer "${from.name}" has no plans${range ? ' in that range' : ''}`)

function lifted(plan) {
	const out = JSON.parse(JSON.stringify(plan))
	if (out.rig && typeof out.rig.y === 'number') out.rig.y = Math.round((out.rig.y + dy) * 1000) / 1000
	if (out.camera?.position) out.camera.position[1] += dy
	return out
}

const ops = frames.map(frame => ({op: 'setPlan', layer: to.id, frame, plan: lifted(source[frame])}))
const conflicts = frames.filter(f => target[f])

console.log(`${from.name} → ${to.name}: ${frames.length} plans (F${frames[0]}–F${frames[frames.length - 1]}), rig Y ${dy >= 0 ? '+' : ''}${dy} mm`)
for (const op of ops.slice(0, 3).concat(ops.length > 3 ? [ops[ops.length - 1]] : [])) {
	const p = op.plan
	console.log(
		`  F${op.frame}: rig y ${source[op.frame].rig?.y} → ${p.rig?.y}` +
			(p.cameraConfigs?.focusDistance !== undefined ? `, focus ${p.cameraConfigs.focusDistance}` : '') +
			(p.led ? ', led' : '')
	)
}
if (conflicts.length) {
	console.log(`${conflicts.length} frames already have a plan on "${to.name}"${flags.force ? ' — replaced (--force)' : ' — the patch will be rejected (add --force to replace)'}`)
}

if (!flags.write) {
	console.log('dry run — add --write to drop the patch into _inbox/')
	process.exit(0)
}

async function writeAtomic(path, data) {
	await mkdir(dirname(path), {recursive: true})
	const tmp = `${path}.tmp-${process.pid}`
	await writeFile(tmp, data)
	await rename(tmp, path)
}

const patch = {
	version: 1,
	note: `Copy plans ${from.name} → ${to.name}, rig Y ${dy >= 0 ? '+' : ''}${dy} mm`,
	onConflict: flags.force ? 'overwrite' : 'reject',
	ops,
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const rel = `_inbox/${stamp}-plan-copy-${to.id}.json`
await writeAtomic(join(projectDir, rel), JSON.stringify(patch, null, '\t'))
console.log(`Wrote ${rel} — koma applies it when the project is open (see _inbox/applied/ or _inbox/rejected/).`)
