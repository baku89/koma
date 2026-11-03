#!/usr/bin/env node
/**
 * Re-make the `.lv.jpg` previews of a koma project from the full-size jpgs,
 * contain-fitted into the project resolution (the whole picture, at most
 * resolution-sized, no padding) — what koma makes since 2026-10-27. Needed
 * once for shots whose lv was cover-cropped (guide clips with another aspect
 * than the project). Only the lv files are rewritten; project.json is not
 * touched. Reload koma afterwards (its preview cache keeps the old bytes).
 *
 *   node scripts/regen-lv.mjs <project-dir> [--layer <name|id>] [--dry-run]
 */

import {execFile} from 'node:child_process'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {promisify} from 'node:util'

const run = promisify(execFile)
const args = process.argv.slice(2)
const positional = args.filter(a => !a.startsWith('--'))
function opt(name, def) {
	const i = args.indexOf(`--${name}`)
	if (i === -1) return def
	const v = args[i + 1]
	return v === undefined || v.startsWith('--') ? true : v
}
const [dir] = positional
if (!dir) {
	console.error('usage: regen-lv.mjs <project-dir> [--layer <name|id>] [--dry-run]')
	process.exit(1)
}
const LAYER = opt('layer', null)
const DRY = opt('dry-run', false) === true

const project = JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf8'))
const [W, H] = project.resolution
const layerIndex = LAYER === null ? null : project.layers.findIndex(l => l.name === LAYER || l.id === LAYER)
if (LAYER !== null && layerIndex === -1) {
	console.error(`no layer "${LAYER}" (have ${project.layers.map(l => l.name).join(', ')})`)
	process.exit(1)
}
const file = ref => (ref && typeof ref === 'object' && ref.$type === 'blob' ? ref.filename : null)

const jobs = []
project.komas.forEach((koma, frame) => {
	koma.shots?.forEach((shot, layer) => {
		if (!shot || (layerIndex !== null && layer !== layerIndex)) return
		const jpg = file(shot.jpg)
		const lv = file(shot.lv)
		if (jpg && lv && jpg !== lv) jobs.push({frame, layer, jpg, lv})
	})
})
console.log(`${jobs.length} shots with a jpg and an lv${LAYER ? ` on "${LAYER}"` : ''}; fitting into ${W}×${H}`)
if (DRY) {
	for (const j of jobs.slice(0, 5)) console.log(`  #${j.frame} L${j.layer}: ${j.jpg} → ${j.lv}`)
	process.exit(0)
}
let done = 0
const JOBS = 6
await Promise.all(
	Array.from({length: JOBS}, async () => {
		for (;;) {
			const j = jobs.shift()
			if (!j) return
			await run('ffmpeg', [
				'-v', 'error', '-nostdin', '-y', '-i', path.join(dir, j.jpg),
				'-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
				'-q:v', '3', path.join(dir, j.lv),
			])
			if (++done % 50 === 0) console.log(`${done} done`)
		}
	})
)
console.log(`rewrote ${done} lv files — reload koma`)
