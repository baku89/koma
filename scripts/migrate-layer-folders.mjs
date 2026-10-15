#!/usr/bin/env node
/**
 * Move a koma project from the flat image layout to one folder per layer
 * (ADDSUB.md §14.2, src/utils/projectLayout.ts) by renaming — no copying —
 * which koma itself can't do on a folder outside the browser's own storage.
 *
 *   node scripts/migrate-layer-folders.mjs <project-dir> [--write]
 *
 * Without --write it only prints what would happen. Close koma (or make sure
 * this project isn't open in it) before writing: a running koma would save
 * the old paths back over project.json.
 *
 *   <name>_layer=<slot>_0001.jpg          → <layer dir>/0001.jpg
 *   <name>_layer=<slot>_0001.lv.jpg       → <layer dir>/0001.lv.jpg
 *   <name>_layer=<slot>_0001.dng          → <layer dir>/0001.dng
 *   _trash/<id>__<name>_layer=…_0001.jpg  → _trash/<layer dir>/<id>__0001.jpg
 *   gcode/<layer id>/<file>.nc            → <layer dir>/gcode/<file>.nc
 *
 * The layer dir is made from the layer's name (same rule as koma's
 * layerDirName — keep the two in step). project.json gets `assetLayout: 2`
 * and each layer its `dir`; the previous project.json is kept next to it.
 * Backup shots (koma.backupShots) have no slot and stay where they are.
 */

import {existsSync} from 'node:fs'
import {copyFile, mkdir, readdir, readFile, rename, rmdir, stat, writeFile} from 'node:fs/promises'
import path from 'node:path'

import {layerDirName} from './lib/layerDir.mjs'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const projectDir = args.find(a => !a.startsWith('--'))
if (!projectDir) {
	console.error('usage: migrate-layer-folders.mjs <project-dir> [--write]')
	process.exit(1)
}

const seq = n => String(n).padStart(4, '0')
const typeOf = f => (f.endsWith('.lv.jpg') ? 'lv' : /\.dng$/i.test(f) ? 'raw' : 'jpg')
const frameFile = (frame, type) => `${seq(frame)}${type === 'lv' ? '.lv' : ''}.${type === 'raw' ? 'dng' : 'jpg'}`
const refName = ref => (typeof ref === 'string' ? ref : ref && ref.$type === 'blob' ? ref.filename : undefined)
const setRef = (shot, key, filename) => {
	shot[key] = typeof shot[key] === 'string' ? filename : {...shot[key], filename}
}

const projectFile = path.join(projectDir, 'project.json')
const project = JSON.parse(await readFile(projectFile, 'utf8'))
if (project.assetLayout === 2) {
	console.log('already on layer folders (assetLayout 2) — nothing to do')
	process.exit(0)
}

// ---- layer folders
const layers = project.layers ?? []
const taken = layers.flatMap(l => (l.dir ? [l.dir] : []))
for (const l of layers) {
	if (!l.dir) {
		l.dir = layerDirName(l.name ?? 'Layer', taken)
		taken.push(l.dir)
	}
}
const dirOf = i => {
	const d = layers[i]?.dir
	if (!d) throw new Error(`shot on layer slot ${i} but the project has no such layer`)
	return d
}

// ---- plan every rename: [from, to] relative to the project folder
const moves = []
const notes = []
let backups = 0
let extChanges = 0

project.komas.forEach((koma, frame) => {
	if (!koma) return
	koma.shots?.forEach((shot, layer) => {
		if (!shot) return
		for (const key of ['lv', 'jpg', 'raw']) {
			const from = refName(shot[key])
			if (from === undefined) continue
			if (from.includes('/')) continue // already in a folder
			const type = key
			const to = `${dirOf(layer)}/${frameFile(frame, type)}`
			if (path.extname(from).toLowerCase() !== path.extname(to)) extChanges++
			moves.push([from, to])
			setRef(shot, key, to)
		}
	})
	if (koma.backupShots?.length) backups += koma.backupShots.length
})

for (const t of project.trash ?? []) {
	if (!t?.shot) continue
	for (const key of ['lv', 'jpg', 'raw']) {
		const from = refName(t.shot[key])
		if (from === undefined || from.includes('/')) continue
		const id = from.includes('__') ? from.slice(0, from.indexOf('__')) : 'x'
		const to = `${dirOf(t.layer ?? 0)}/${id}__${frameFile(t.frame ?? 0, key)}`
		moves.push([`_trash/${from}`, `_trash/${to}`])
		setRef(t.shot, key, to)
	}
}

// G-code attached to frames: by record first, then whatever is left in gcode/<layer id>/.
const cuts = project.addsub?.cuts ?? {}
const layerById = Object.fromEntries(layers.map(l => [l.id, l]))
for (const [layerId, table] of Object.entries(cuts)) {
	const dir = layerById[layerId]?.dir
	if (!dir) {
		notes.push(`cuts recorded for unknown layer ${layerId}: left alone`)
		continue
	}
	for (const cut of Object.values(table)) {
		if (cut?.source !== 'file' || typeof cut.file !== 'string') continue
		if (!cut.file.startsWith('gcode/')) continue
		const to = `${dir}/gcode/${path.basename(cut.file)}`
		if (!existsSync(path.join(projectDir, cut.file))) {
			notes.push(`missing G-code ${cut.file} (record kept as is)`)
			continue
		}
		moves.push([cut.file, to])
		cut.file = to
	}
}
for (const l of layers) {
	const stray = path.join(projectDir, 'gcode', l.id)
	if (!existsSync(stray)) continue
	for (const name of await readdir(stray)) {
		const from = `gcode/${l.id}/${name}`
		if (moves.some(([f]) => f === from)) continue
		if ((await stat(path.join(projectDir, from))).isDirectory()) continue
		moves.push([from, `${l.dir}/gcode/${name}`])
	}
}

// ---- checks (nothing has been touched yet)
const problems = []
const targets = new Map()
for (const [from, to] of moves) {
	if (!existsSync(path.join(projectDir, from))) problems.push(`missing: ${from}`)
	if (existsSync(path.join(projectDir, to))) problems.push(`target exists: ${to}`)
	if (targets.has(to)) problems.push(`two files want ${to}: ${targets.get(to)} and ${from}`)
	targets.set(to, from)
}

project.assetLayout = 2

console.log(`${projectDir}`)
console.log(`  layers: ${layers.map(l => `${l.id} → ${JSON.stringify(l.dir)}`).join(', ')}`)
console.log(`  ${moves.length} renames (${moves.filter(m => m[0].startsWith('_trash/')).length} in _trash, ${moves.filter(m => /\.(nc|gcode|ngc|tap|cnc|txt)$/i.test(m[0])).length} G-code)`)
if (backups) console.log(`  ${backups} backup shots keep their files where they are`)
if (extChanges) console.log(`  ${extChanges} files change extension to koma's (.jpg) — the content is unchanged`)
for (const n of notes) console.log(`  note: ${n}`)
for (const [from, to] of moves.slice(0, 6)) console.log(`    ${from}  →  ${to}`)
if (moves.length > 6) console.log(`    … ${moves.length - 6} more`)
if (problems.length) {
	console.error(`\n${problems.length} problems — nothing written:`)
	for (const p of problems.slice(0, 30)) console.error(`  ${p}`)
	process.exit(1)
}
if (!WRITE) {
	console.log('\ndry run — add --write to do it (close koma first)')
	process.exit(0)
}

// ---- apply
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
await copyFile(projectFile, path.join(projectDir, `project.json.before-layer-folders-${stamp}`))
const dirs = new Set(moves.map(([, to]) => path.dirname(to)))
for (const d of dirs) await mkdir(path.join(projectDir, d), {recursive: true})
let done = 0
for (const [from, to] of moves) {
	await rename(path.join(projectDir, from), path.join(projectDir, to))
	if (++done % 500 === 0) console.log(`  ${done}/${moves.length}`)
}
await writeFile(projectFile, JSON.stringify(project))
// Folders the moves emptied.
for (const l of layers) {
	for (const d of [path.join(projectDir, 'gcode', l.id)]) {
		if (existsSync(d) && (await readdir(d)).length === 0) await rmdir(d)
	}
}
console.log(`done: ${moves.length} files renamed, project.json written (previous copy kept next to it)`)
