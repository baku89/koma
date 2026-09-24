#!/usr/bin/env node
/**
 * Add an image sequence (e.g. a previz render) to an existing koma project as
 * a new named layer, one image per frame from frame 0.
 *
 *   node scripts/import-sequence.mjs <image-dir> <project-dir> --name "Previz"
 *        [--lv-max 1280] [--jobs 8] [--preset default] [--no-preset]
 *
 * The full image is copied as the shot's `jpg`; a downscaled `_lv` preview is
 * made with sips (macOS). The layer is appended to the given preset (default:
 * the active one) at the top of the stack; `--no-preset` leaves it hidden.
 * Not a "take": no captureDate, so the exhibition screen (which prefers an
 * "Exhibit" preset) is unaffected unless that preset includes it.
 */

import {copyFile, mkdir, readdir, readFile, writeFile} from 'node:fs/promises'
import {execFile} from 'node:child_process'
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
const [srcDir, projectDir] = positional
if (!srcDir || !projectDir) {
	console.error('usage: import-sequence.mjs <image-dir> <project-dir> --name N [--lv-max 1280] [--jobs 8] [--preset id|--no-preset]')
	process.exit(1)
}
const LAYER_NAME = String(opt('name', path.basename(srcDir)))
const LV_MAX = Number(opt('lv-max', 1280))
const JOBS = Number(opt('jobs', 8))
const NO_PRESET = opt('no-preset', false) === true
const PRESET = opt('preset', null)

const projectFile = path.join(projectDir, 'project.json')
const project = JSON.parse(await readFile(projectFile, 'utf8'))
const files = (await readdir(srcDir)).filter(f => /\.(jpe?g|png)$/i.test(f)).sort()
if (files.length === 0) {
	console.error('no images found')
	process.exit(1)
}

const layerIndex = project.layers.length
const layerId = 'L' + Math.random().toString(36).slice(2, 10)
project.layers.push({id: layerId, name: LAYER_NAME})

const name = project.name
const seq = n => String(n).padStart(4, '0')
const blob = filename => ({$type: 'blob', filename})

let active = 0
const queue = []
const enqueue = fn =>
	new Promise((resolve, reject) => {
		queue.push({fn, resolve, reject})
		pump()
	})
function pump() {
	while (active < JOBS && queue.length) {
		const {fn, resolve, reject} = queue.shift()
		active++
		fn().then(resolve, reject).finally(() => {
			active--
			pump()
		})
	}
}

const jobs = []
files.forEach((file, frame) => {
	const ext = /\.png$/i.test(file) ? 'png' : 'jpg'
	const base = `${name}_layer=${layerIndex}_${seq(frame)}`
	const jpgName = `${base}.${ext}`
	const lvName = `${base}.lv.jpg`
	const src = path.join(srcDir, file)
	jobs.push(enqueue(() => copyFile(src, path.join(projectDir, jpgName))))
	jobs.push(
		enqueue(() =>
			run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', '-Z', String(LV_MAX), src, '--out', path.join(projectDir, lvName)])
		)
	)
	while (project.komas.length <= frame) project.komas.push({shots: []})
	const shots = project.komas[frame].shots
	while (shots.length <= layerIndex) shots.push(null)
	shots[layerIndex] = {lv: blob(lvName), jpg: blob(jpgName), jpgFilename: file, importedFrom: src}
})
// Keep a trailing empty koma for the capture slot.
if (project.komas[project.komas.length - 1].shots.some(Boolean)) project.komas.push({shots: []})
project.previewRange = [0, Math.max(0, project.komas.length - 2)]

if (!NO_PRESET) {
	const id = PRESET ?? project.activeLayerPreset
	const preset = project.layerPresets.find(p => p.id === id) ?? project.layerPresets[0]
	preset.layers.push({layerId, opacity: 1, mixBlendMode: 'normal'})
}

console.log(`${files.length} images → layer ${layerIndex} "${LAYER_NAME}" (${jobs.length / 2} frames)…`)
let done = 0
for (const j of jobs) {
	await j
	if (++done % 200 === 0) console.log(`  ${done}/${jobs.length}`)
}
await mkdir(projectDir, {recursive: true})
await writeFile(projectFile, JSON.stringify(project))
console.log('wrote project.json')
