#!/usr/bin/env node
/**
 * Import Dragonframe scene packages (*.dgn) into a koma project.
 *
 *   node scripts/import-dragonframe.mjs <dgn-root> <dest-dir> [--name "Project"]
 *        [--fps 18] [--jpg-max 3000] [--lv-max 1920] [--jobs 6] [--dry-run]
 *
 * Every take (`<Scene>_Take_<n>/<Scene>_<n>_X1/*.jpg`) becomes one named
 * layer starting at frame 0. Frames the take's EDL (take.xml) no longer
 * references (deleted / re-shot) go to the trash ledger with the frame they
 * occupied, so they show up in Retakes and on the exhibition screen.
 *
 * Metadata: exposure / ISO / aperture / focal length / white balance / model
 * from EXIF (exiftool), camera settings from take.xml, capture dates from
 * EXIF corrected by the camera-clock offset implied by <Scene>_meta.txt's
 * FIRST FRAME. Images are re-encoded with sips (macOS): a downscaled "hi-res"
 * jpg and koma's `_lv` preview. RAWs are not copied (rawFilename is kept).
 *
 * Needs: macOS `sips`, `exiftool` on PATH. No npm dependencies.
 */

import {execFile} from 'node:child_process'
import {mkdir, readdir, readFile, stat, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {promisify} from 'node:util'

const run = promisify(execFile)

//------------------------------------------------------------------------------
// Args

const args = process.argv.slice(2)
const positional = args.filter(a => !a.startsWith('--'))
function opt(name, def) {
	const i = args.indexOf(`--${name}`)
	if (i === -1) return def
	const v = args[i + 1]
	return v === undefined || v.startsWith('--') ? true : v
}
const [srcRoot, destDir] = positional
if (!srcRoot || !destDir) {
	console.error('usage: import-dragonframe.mjs <dgn-root> <dest-dir> [--name N] [--fps 18] [--jpg-max 3000] [--lv-max 1920] [--jobs 6] [--dry-run]')
	process.exit(1)
}
const NAME = String(opt('name', path.basename(destDir)))
const FPS = Number(opt('fps', 18))
const JPG_MAX = Number(opt('jpg-max', 3000))
const LV_MAX = Number(opt('lv-max', 1920))
const JOBS = Number(opt('jobs', 6))
const DRY = opt('dry-run', false) === true

//------------------------------------------------------------------------------
// Discover takes

async function isDir(p) {
	try {
		return (await stat(p)).isDirectory()
	} catch {
		return false
	}
}

async function listDgns(root) {
	const entries = await readdir(root)
	return entries.filter(e => e.endsWith('.dgn')).sort().map(e => path.join(root, e))
}

async function listTakes(dgn) {
	const scene = path.basename(dgn, '.dgn')
	const entries = await readdir(dgn)
	const takes = []
	for (const e of entries) {
		const m = e.match(new RegExp(`^${escapeRe(scene)}_Take_(.+)$`))
		if (!m) continue
		const takeDir = path.join(dgn, e)
		if (!(await isDir(takeDir))) continue
		const takeId = m[1]
		const x1 = path.join(takeDir, `${scene}_${takeId}_X1`)
		if (!(await isDir(x1))) continue
		const all = await readdir(x1)
		const files = all.filter(f => /\.jpe?g$/i.test(f)).sort()
		if (files.length === 0) continue
		takes.push({scene, takeId, takeDir, x1, files, all: new Set(all)})
	}
	return takes
}

function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

//------------------------------------------------------------------------------
// take.xml / meta.txt

function parseTakeXml(xml) {
	const settings = {}
	const camera = xml.match(/<scen:cameraSettings[^>]*camera="([^"]*)"/)?.[1]
	const block = xml.match(/<scen:cameraSettings[\s\S]*?<\/scen:cameraSettings>/)?.[0] ?? ''
	for (const m of block.matchAll(/<scen:setting property="([^"]*)" value="([^"]*)"\/>/g)) {
		settings[m[1]] = m[2]
	}
	const edl = []
	for (const m of xml.matchAll(/<scen:vframe\s+([^>]*)\/>/g)) {
		const file = Number(m[1].match(/file="(\d+)"/)?.[1])
		const vframe = Number(m[1].match(/vframe="(\d+)"/)?.[1])
		if (Number.isFinite(file) && Number.isFinite(vframe)) edl.push({file, vframe})
	}
	const endFrame = Number(xml.match(/endFrame="(\d+)"/)?.[1])
	return {camera, settings, edl, endFrame: Number.isFinite(endFrame) ? endFrame : undefined}
}

/** `Take_01` → {first: Date, last: Date, frames: string} from <Scene>_meta.txt */
function parseMeta(text) {
	const out = new Map()
	const blocks = text.split(/^-{10,}\s*$/m)
	for (const b of blocks) {
		const take = b.match(/^\s*Take_(\S+)\s*$/m)?.[1]
		if (!take) continue
		const first = b.match(/FIRST FRAME:\s*([\d-]+ [\d:]+)/)?.[1]
		const last = b.match(/LAST FRAME:\s*([\d-]+ [\d:]+)/)?.[1]
		const frames = b.match(/FRAMES:\s*(.+)/)?.[1]?.trim()
		out.set(take, {
			first: first ? new Date(first.replace(' ', 'T')) : null,
			last: last ? new Date(last.replace(' ', 'T')) : null,
			frames,
		})
	}
	return out
}

//------------------------------------------------------------------------------
// EXIF

async function exifOf(dir, files) {
	const {stdout} = await run(
		'exiftool',
		[
			'-j', '-n', '-fast2',
			'-DateTimeOriginal', '-SubSecTimeOriginal', '-ExposureTime', '-FNumber', '-ISO',
			'-FocalLength', '-WhiteBalance', '-ColorTemperature', '-Model', '-LensModel',
			...files,
		],
		{cwd: dir, maxBuffer: 64 * 1024 * 1024}
	)
	const map = new Map()
	for (const e of JSON.parse(stdout)) map.set(path.basename(e.SourceFile), e)
	return map
}

function exifDate(e) {
	if (!e?.DateTimeOriginal) return null
	const m = String(e.DateTimeOriginal).match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
	if (!m) return null
	const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`)
	const sub = e.SubSecTimeOriginal
	if (sub !== undefined && sub !== null && String(sub) !== '') {
		d.setMilliseconds(Number(String(sub).padEnd(3, '0').slice(0, 3)))
	}
	return d
}

function shutterString(sec) {
	if (sec === undefined || sec === null) return undefined
	const s = Number(sec)
	if (!Number.isFinite(s) || s <= 0) return undefined
	if (s >= 1) return String(Math.round(s * 10) / 10)
	return `1/${Math.round(1 / s)}`
}

// EXIF WhiteBalance comes back numeric with -n (0 = Auto, 1 = Manual);
// Panasonic's descriptive "Kelvin" etc. appear without -n.
const WB = {
	0: 'auto',
	1: 'manual',
	Kelvin: 'manual',
	Auto: 'auto',
	Daylight: 'daylight',
	Shade: 'shade',
	Cloudy: 'cloud',
	Tungsten: 'incandescent',
	Fluorescent: 'fluorescent',
	Flash: 'flash',
	Manual: 'manual',
}

function cameraConfigs(exif, take) {
	const c = {}
	const model = exif?.Model ?? take.camera
	if (model) c.model = String(model)
	const ss = shutterString(exif?.ExposureTime) ?? take.settings['Shutter Speed']
	if (ss) c.shutterSpeed = ss
	const ap = exif?.FNumber ?? Number(take.settings['Aperture'])
	if (Number.isFinite(Number(ap))) c.aperture = Number(ap)
	const iso = exif?.ISO ?? Number(take.settings['ISO'])
	if (Number.isFinite(Number(iso))) c.iso = Number(iso)
	if (Number.isFinite(Number(exif?.FocalLength))) c.focalLength = Number(exif.FocalLength)
	const wb = exif?.WhiteBalance !== undefined ? WB[exif.WhiteBalance] ?? String(exif.WhiteBalance).toLowerCase() : undefined
	if (wb) c.whiteBalance = wb
	else if (take.settings['White Balance'] === 'Color Temperature') c.whiteBalance = 'manual'
	const ct = take.settings['Color Temperature']?.match(/(\d+)/)?.[1]
	if (ct) c.colorTemperature = Number(ct)
	if (take.settings['Image Quality']) c.imageQuality = take.settings['Image Quality'].toLowerCase()
	return c
}

//------------------------------------------------------------------------------
// Image conversion (sips), with a small worker pool

const queue = []
let active = 0
function enqueue(fn) {
	return new Promise((resolve, reject) => {
		queue.push({fn, resolve, reject})
		pump()
	})
}
function pump() {
	while (active < JOBS && queue.length) {
		const {fn, resolve, reject} = queue.shift()
		active++
		fn()
			.then(resolve, reject)
			.finally(() => {
				active--
				pump()
			})
	}
}

async function convert(src, dest, maxPx, quality) {
	if (DRY) return
	await run('sips', [
		'-s', 'format', 'jpeg',
		'-s', 'formatOptions', String(quality),
		'-Z', String(maxPx),
		src,
		'--out', dest,
	])
}

//------------------------------------------------------------------------------
// Main

const TRASH_DIR = '_trash'
const seq = n => String(n).padStart(4, '0')
const blob = filename => ({$type: 'blob', filename})
const newId = prefix => prefix + Math.random().toString(36).slice(2, 10)

const dgns = await listDgns(srcRoot)
const allTakes = []
for (const dgn of dgns) {
	const meta = parseMeta(await readFile(path.join(dgn, `${path.basename(dgn, '.dgn')}_meta.txt`), 'utf8').catch(() => ''))
	for (const t of await listTakes(dgn)) {
		const xml = await readFile(path.join(t.takeDir, 'take.xml'), 'utf8').catch(() => '')
		const take = parseTakeXml(xml)
		const m = meta.get(t.takeId)
		allTakes.push({...t, take, metaFirst: m?.first ?? null, metaLast: m?.last ?? null})
	}
}

// Order takes by their real first-frame date (meta.txt), so layers list
// chronologically.
allTakes.sort((a, b) => (a.metaFirst?.getTime() ?? 0) - (b.metaFirst?.getTime() ?? 0))

console.log(`${allTakes.length} takes in ${dgns.length} scenes → ${destDir}`)

if (!DRY) {
	await mkdir(destDir, {recursive: true})
	await mkdir(path.join(destDir, TRASH_DIR), {recursive: true})
}

const layers = [{id: 'main', name: 'Main'}]
const komas = []
const trash = []
const jobs = []
let totalLive = 0
let totalTrash = 0

for (const t of allTakes) {
	const layerIndex = layers.length
	const layerId = newId('L')
	const layerName = `${t.scene} ${t.takeId.replace(/^0+(?=\d)/, '')}`
	layers.push({id: layerId, name: layerName})

	const exif = await exifOf(t.x1, t.files)

	// Camera clock correction: meta.txt's FIRST FRAME is the authoritative wall
	// clock for the first frame of the EDL.
	const edl = t.take.edl.length ? t.take.edl : t.files.map((_, i) => ({file: i + 1, vframe: i + 1}))
	const fileOf = n => t.files.find(f => f.endsWith(`_${seq(n)}.jpg`) || f.endsWith(`_${seq(n)}.JPG`))
	const firstFile = fileOf(edl[0]?.file)
	const firstExif = firstFile ? exifDate(exif.get(firstFile)) : null
	let offsetMs = 0
	if (t.metaFirst && firstExif) offsetMs = t.metaFirst.getTime() - firstExif.getTime()
	const liveFiles = new Map(edl.map(e => [e.file, e.vframe]))

	const makeShot = (file, frame, target) => {
		const e = exif.get(file)
		const date = exifDate(e)
		const base = `${NAME}_layer=${layerIndex}_${seq(frame)}`
		const jpgName = target === 'trash' ? `${newId('T')}__${base}.jpg` : `${base}.jpg`
		const lvName = target === 'trash' ? `${newId('T')}__${base}.lv.jpg` : `${base}.lv.jpg`
		const outDir = target === 'trash' ? path.join(destDir, TRASH_DIR) : destDir
		const src = path.join(t.x1, file)
		jobs.push(enqueue(() => convert(src, path.join(outDir, jpgName), JPG_MAX, 90)))
		jobs.push(enqueue(() => convert(src, path.join(outDir, lvName), LV_MAX, 88)))
		const rawName = ['.rw2', '.RW2', '.dng', '.cr2', '.arw']
			.map(ext => file.replace(/\.jpe?g$/i, ext))
			.find(n => t.all.has(n))
		return {
			lv: blob(lvName),
			jpg: blob(jpgName),
			jpgFilename: file,
			rawFilename: rawName,
			cameraConfigs: cameraConfigs(e, t.take),
			captureDate: date ? date.getTime() + offsetMs : undefined,
			importedFrom: path.relative(srcRoot, src),
		}
	}

	for (const file of t.files) {
		const n = Number(file.match(/_(\d+)\.jpe?g$/i)?.[1])
		if (!Number.isFinite(n)) continue
		const vframe = liveFiles.get(n)
		if (vframe !== undefined) {
			const frame = vframe - 1
			while (komas.length <= frame) komas.push({shots: []})
			const shots = komas[frame].shots
			while (shots.length <= layerIndex) shots.push(null)
			shots[layerIndex] = makeShot(file, frame, 'live')
			totalLive++
		} else {
			// Not in the EDL any more: a discarded take. It sat at the frame its
			// file number implies (Dragonframe numbers files sequentially).
			const frame = n - 1
			const shot = makeShot(file, frame, 'trash')
			trash.push({shot, frame, layer: layerIndex, deletedAt: shot.captureDate ?? Date.now()})
			totalTrash++
		}
	}
	console.log(`  ${layerName}: ${liveFiles.size} frames, ${t.files.length - liveFiles.size} discarded, clock offset ${Math.round(offsetMs / 1000)} s`)
}

// Trailing empty koma so the capture slot has somewhere to land.
komas.push({shots: []})

const project = {
	name: NAME,
	fps: FPS,
	captureShot: {frame: 0, layer: 0},
	previewRange: [0, Math.max(0, komas.length - 2)],
	onionskin: 0,
	komas,
	resolution: [1920, 1280],
	timeline: {zoomFactor: 1},
	isLooping: true,
	layers,
	layerPresets: [
		{
			id: 'default',
			name: 'All takes',
			layers: layers.map(l => ({layerId: l.id, opacity: 1, mixBlendMode: 'normal'})),
		},
		{
			id: 'main-only',
			name: 'Main only',
			layers: [{layerId: 'main', opacity: 1, mixBlendMode: 'normal'}],
		},
	],
	activeLayerPreset: 'default',
	audio: {startFrame: 0},
	markers: [],
	trash,
}

console.log(`${totalLive} live frames, ${totalTrash} discarded takes, ${layers.length} layers, ${komas.length} komas`)
console.log(`converting ${jobs.length} images (${JOBS} parallel)…`)
let done = 0
for (const j of jobs) {
	await j
	done++
	if (done % 100 === 0) console.log(`  ${done}/${jobs.length}`)
}
if (!DRY) {
	await writeFile(path.join(destDir, 'project.json'), JSON.stringify(project))
	console.log('wrote project.json')
}
