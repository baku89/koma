#!/usr/bin/env node
/**
 * Step a frame's cut down over the following frames (addsub).
 *
 * Takes the G-code attached to one frame, shifts every absolute Z by a
 * cumulative step, and attaches the results to a run of frames; optionally
 * gives those frames a plan whose rig Y steps along with it.
 *
 *   node scripts/addsub-zstep.mjs <project-dir> --from 37 --start 40 \
 *     --count 20 --dz -0.5 [--rig-dy -0.5] [--plan-from 39] [--layer main] \
 *     [--write] [--direct] [--force]
 *
 * Without --write it only reports what it would do. With --write it writes
 * the G-code files to gcode/<layer>/ and a patch to the project's _inbox/
 * (src/stores/inbox.ts): koma applies it to the open project — or the next
 * time the project is opened — and files it under _inbox/applied/ or
 * _inbox/rejected/. project.json itself is never touched, so koma's
 * autosave cannot undo it and it can be run at any time.
 *
 * --direct edits project.json instead (for a koma without the inbox). That
 * only sticks if koma is not about to save: run it while koma shows the
 * project as saved and reload koma right after.
 */
import {copyFile, mkdir, readFile, rename, stat, writeFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'

//------------------------------------------------------------------------------
// Arguments

const argv = process.argv.slice(2)
const flags = {}
const positional = []
for (let i = 0; i < argv.length; i++) {
	const a = argv[i]
	if (a === '--write' || a === '--force' || a === '--direct') flags[a.slice(2)] = true
	else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i]
	else positional.push(a)
}

const projectDir = positional[0]
const from = Number(flags.from)
const start = Number(flags.start)
const count = Number(flags.count)
const dz = Number(flags.dz)
const rigDy = flags['rig-dy'] === undefined ? null : Number(flags['rig-dy'])
const planFrom = flags['plan-from'] === undefined ? start - 1 : Number(flags['plan-from'])
const layerId = flags.layer ?? 'main'

if (!projectDir || ![from, start, count, dz].every(Number.isFinite)) {
	console.error(
		'usage: addsub-zstep.mjs <project-dir> --from N --start N --count N --dz MM [--rig-dy MM] [--plan-from N] [--layer ID] [--write] [--direct] [--force]'
	)
	process.exit(2)
}

//------------------------------------------------------------------------------
// G-code

function fmt(n) {
	return n.toFixed(4).replace(/\.?0+$/, '').replace(/^-0$/, '0') || '0'
}

/** Code outside `( … )` and `; …` comments, upper-cased. */
function codeOf(line) {
	return line.replace(/\(.*?\)/g, '').replace(/;.*$/, '').toUpperCase()
}

/**
 * Add `shift` to every Z word that is an absolute work coordinate: lines in
 * G90, except those that address something else (G28/G30 home moves, G53
 * machine moves, G10/G92 offsets, G4 dwell). G91 lines are left alone.
 * Returns the new text and the lines it changed.
 */
function shiftZ(text, shift) {
	let absolute = true
	const changed = []
	const out = text.split(/\r?\n/).map((raw, i) => {
		const code = codeOf(raw)
		// The distance mode set on a line applies to that line.
		if (/G91(?!\.)/.test(code)) absolute = false
		if (/G90(?!\.)/.test(code)) absolute = true
		if (!absolute) return raw
		if (/G(28|30|53|10|92|0?4)(?![\d.])/.test(code)) return raw
		// Rewrite the Z word in the code part only (comments stay as they are).
		let touched = false
		const next = raw.replace(
			/(\(.*?\)|;.*$)|([Zz])\s*([-+]?\d*\.?\d+)/g,
			(m, comment, z, value) => {
				if (comment !== undefined) return m
				touched = true
				return `${z}${fmt(Number(value) + shift)}`
			}
		)
		if (touched) changed.push({line: i + 1, from: raw.trim(), to: next.trim()})
		return next
	})
	return {text: out.join('\n'), changed}
}

/** Lines koma would send (comments and blanks stripped) — `cut.lines`. */
function sendableLines(text) {
	return text
		.split(/\r?\n/)
		.map(l => l.replace(/\(.*?\)/g, '').replace(/;.*$/, '').trim())
		.filter(l => l && l !== '%').length
}

function safeName(name) {
	return name.replace(/[\\/:*?"<>|]/g, '_')
}

//------------------------------------------------------------------------------
// Build

const projectPath = join(projectDir, 'project.json')
const loaded = await readFile(projectPath, 'utf8')
const loadedStat = await stat(projectPath)
const project = JSON.parse(loaded)
const addsub = project.addsub

const layerIndex = project.layers.findIndex(l => l.id === layerId)
if (layerIndex < 0) throw new Error(`No layer with id "${layerId}"`)

const base = addsub.cuts?.[layerId]?.[from]
if (!base || base.source !== 'file') {
	throw new Error(`Frame ${from} of layer "${layerId}" has no attached G-code file`)
}
const baseText = await readFile(join(projectDir, base.file), 'utf8')
const baseName = base.name.replace(/\.[^.]+$/, '')
const ext = base.name.slice(baseName.length)

let basePlan = null
if (rigDy !== null) {
	basePlan = addsub.plan?.[layerId]?.[planFrom]
	if (!basePlan?.rig || basePlan.rig.y === undefined) {
		throw new Error(`Frame ${planFrom} has no plan with a rig pose to step from`)
	}
}

const now = Date.now()
const items = []
const problems = []
for (let i = 0; i < count; i++) {
	const frame = start + i
	const shift = dz * (i + 1)
	const {text, changed} = shiftZ(baseText, shift)
	const name = `${baseName} Z${shift >= 0 ? '+' : ''}${fmt(shift)}${ext}`
	const file = `gcode/${layerId}/${String(frame).padStart(4, '0')}_${safeName(name)}`
	const header = `(Z ${shift >= 0 ? '+' : ''}${fmt(shift)} from "${base.name}", frame ${from} - addsub-zstep)\n`
	const cut = {
		source: 'file',
		file,
		name,
		addedAt: now,
		lines: sendableLines(text),
		estimatedSec: base.estimatedSec,
		run: null,
	}
	const plan =
		basePlan === null
			? null
			: {...basePlan, rig: {...basePlan.rig, y: Number(fmt(basePlan.rig.y + rigDy * (i + 1)))}}
	items.push({frame, shift, file, text: header + text, changed, cut, plan})

	const existingCut = addsub.cuts?.[layerId]?.[frame]
	const existingPlan = addsub.plan?.[layerId]?.[frame]
	const existingShot = project.komas[frame]?.shots?.[layerIndex]
	if (existingCut) problems.push(`frame ${frame} already has a cut (${existingCut.name})`)
	if (plan && existingPlan) problems.push(`frame ${frame} already has a plan`)
	if (existingShot) problems.push(`frame ${frame} already has a shot`)
	const limit = addsub.rigLimits?.y
	if (plan && limit && (plan.rig.y < limit[0] || plan.rig.y > limit[1])) {
		problems.push(`frame ${frame}: rig Y ${plan.rig.y} is outside [${limit[0]}, ${limit[1]}]`)
	}
}

//------------------------------------------------------------------------------
// Report

console.log(`Project   ${project.name}  (${projectPath})`)
console.log(
	`          saved ${Math.round((Date.now() - loadedStat.mtimeMs) / 1000)} s ago, capture frame ${project.captureShot?.frame}`
)
console.log(`Source    frame ${from}: ${base.file}`)
if (basePlan) console.log(`Plan from frame ${planFrom}: rig ${JSON.stringify(basePlan.rig)}`)
console.log('')
console.log('Z words shifted (first target frame):')
for (const c of items[0].changed) console.log(`  line ${c.line}: ${c.from}  ->  ${c.to}`)
console.log('')
console.log('frame   Z shift   rig Y      file')
for (const it of items) {
	console.log(
		`${String(it.frame).padStart(5)}   ${fmt(it.shift).padStart(7)}   ${(it.plan ? fmt(it.plan.rig.y) : '-').padStart(8)}   ${it.file}`
	)
}
if (problems.length) {
	console.log('')
	console.log('Conflicts:')
	for (const p of problems) console.log(`  ${p}`)
}

if (!flags.write) {
	console.log('')
	console.log('Dry run - nothing written. Add --write to apply.')
	process.exit(problems.length ? 1 : 0)
}
if (problems.length && !flags.force) {
	console.error('')
	console.error('Refusing to write over the conflicts above (--force to overwrite).')
	process.exit(1)
}

//------------------------------------------------------------------------------
// Write

async function writeAtomic(path, data) {
	await mkdir(dirname(path), {recursive: true})
	const tmp = `${path}.tmp-${process.pid}`
	await writeFile(tmp, data)
	await rename(tmp, path)
}

for (const it of items) await writeAtomic(join(projectDir, it.file), it.text)

if (!flags.direct) {
	const policy = flags.force ? 'overwrite' : 'reject'
	const end = start + count - 1
	const patch = {
		version: 1,
		note: `F${start}-${end}: "${base.name}" Z ${fmt(dz)}/frame${rigDy === null ? '' : `, rig Y ${fmt(rigDy)}/frame`}`,
		onConflict: policy,
		ops: items.flatMap(it => [
			{op: 'setCut', layer: layerId, frame: it.frame, file: it.file, name: it.cut.name},
			...(it.plan ? [{op: 'setPlan', layer: layerId, frame: it.frame, plan: it.plan}] : []),
		]),
	}
	const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
	const rel = `_inbox/${stamp}-zstep-${start}-${end}.json`
	await writeAtomic(join(projectDir, rel), JSON.stringify(patch, null, '\t'))
	console.log('')
	console.log(`Wrote ${items.length} G-code files and the patch ${rel}`)
	console.log('koma applies it when the project is open (result: _inbox/applied/ or _inbox/rejected/).')
	process.exit(0)
}

// Re-read: only the target frames' records change, on top of whatever koma
// saved since the report above.
const fresh = JSON.parse(await readFile(projectPath, 'utf8'))
fresh.addsub.cuts ??= {}
fresh.addsub.cuts[layerId] ??= {}
fresh.addsub.plan ??= {}
fresh.addsub.plan[layerId] ??= {}
for (const it of items) {
	fresh.addsub.cuts[layerId][it.frame] = it.cut
	if (it.plan) fresh.addsub.plan[layerId][it.frame] = it.plan
}
const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
const backup = join(projectDir, `project.json.before-zstep-${stamp}`)
await copyFile(projectPath, backup)
const written = JSON.stringify(fresh)
await writeAtomic(projectPath, written)
console.log('')
console.log(`Wrote ${items.length} G-code files and project.json (backup: ${backup})`)
console.log('Reload koma now. Checking that koma does not save over it…')

await new Promise(r => setTimeout(r, 4000))
const after = await readFile(projectPath, 'utf8')
if (after === written) {
	console.log('project.json is still as written.')
} else {
	const p = JSON.parse(after)
	const kept = items.every(it => p.addsub?.cuts?.[layerId]?.[it.frame]?.file === it.file)
	console.log(
		kept
			? 'project.json was saved again and still has the new cuts (koma reloaded it).'
			: 'project.json was OVERWRITTEN by koma - the records are gone. Re-run with --write --force while koma is idle, then reload.'
	)
	process.exit(kept ? 0 : 1)
}
