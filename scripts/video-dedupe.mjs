#!/usr/bin/env node
/**
 * Drop the repeated frames of a video (animation on 2s / 3s, a stop-motion
 * reference with held frames…) so that every frame of the result is a new
 * picture = one koma to shoot, and write the After Effects Time Remap
 * keyframes that stretch the shot frames back onto the original timing.
 *
 *   node scripts/video-dedupe.mjs <in.mov> [--out <dir>] [--fps 24]
 *        [--threshold 0.05] [--analyze] [--force]
 *
 * Writes next to the input (or into --out):
 *   <name>.dedupe.mov   ProRes, one unique frame per frame, at --fps (24)
 *   <name>.remap.txt    AE "Keyframe Data": in a comp at the ORIGINAL frame
 *                       rate, select the shot layer's Time Remap (footage
 *                       interpreted at --fps) and paste. Frame i of the comp
 *                       then shows shot u(i) = the unique frame the original
 *                       showed at i, so the layer lines up with the original.
 *   <name>.dedupe.json  frame → unique index, runs (hold lengths), the diffs
 *
 * Duplicate test: frames are decoded at half size, grey, and compared with the
 * LAST KEPT frame; a frame is new when more than --threshold percent of its
 * pixels moved by more than 24 levels (0–255). Rendered / losslessly captured
 * material repeats frames exactly (0 % moved), while a real change of even a
 * small object is ~0.5 % and up, so the default 0.05 % sits in that gap; raise
 * it for camera / codec noise. --analyze prints the per-frame numbers and the
 * hold table without writing anything — run it first and look at the margin
 * it reports between the most-changed dropped frame and the least-changed
 * kept one.
 */

import {spawn} from 'node:child_process'
import {execFile} from 'node:child_process'
import {access, writeFile} from 'node:fs/promises'
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
if (args.includes('--help') || positional.length !== 1) {
	console.error(
		'usage: video-dedupe.mjs <in.mov> [--out <dir>] [--fps 24] [--threshold 0.05] [--analyze] [--force]'
	)
	process.exit(positional.length === 1 ? 0 : 1)
}
const input = path.resolve(positional[0])
const outDir = path.resolve(String(opt('out', path.dirname(input))))
const OUT_FPS = Number(opt('fps', 24))
const THRESHOLD = Number(opt('threshold', 0.05)) // % of pixels moved
const PIXEL_STEP = 24 // a pixel 'moved' when |Δ| exceeds this (0–255)
const ANALYZE = opt('analyze', false) === true
const FORCE = opt('force', false) === true
if (!(OUT_FPS > 0) || !(THRESHOLD >= 0)) {
	console.error('--fps must be > 0 and --threshold >= 0')
	process.exit(1)
}

const stem = path.basename(input).replace(/\.[^.]+$/, '')
const outVideo = path.join(outDir, `${stem}.dedupe.mov`)
const outRemap = path.join(outDir, `${stem}.remap.txt`)
const outJson = path.join(outDir, `${stem}.dedupe.json`)

//------------------------------------------------------------------------------
// Probe

const {stdout: probeJson} = await run('ffprobe', [
	'-v', 'error', '-select_streams', 'v:0',
	'-show_entries', 'stream=codec_name,profile,width,height,r_frame_rate,avg_frame_rate,nb_frames,pix_fmt',
	'-of', 'json', input,
])
const stream = JSON.parse(probeJson).streams?.[0]
if (!stream) {
	console.error(`${input}: no video stream`)
	process.exit(1)
}
const [num, den] = (stream.avg_frame_rate !== '0/0' ? stream.avg_frame_rate : stream.r_frame_rate).split('/').map(Number)
const srcFps = num / den
const {width, height} = stream
const expectFrames = Number(stream.nb_frames) || null

//------------------------------------------------------------------------------
// Pass 1: decode small grey frames, measure each against the last kept one

const AW = Math.max(2, Math.round(width / 4) * 2)
const AH = Math.max(2, Math.round(height / 4) * 2)
const frameBytes = AW * AH

const diffs = [] // % of pixels moved vs the last kept frame, per source frame (frame 0 → 0)
const kept = [] // source frame indices that are new pictures
const unique = [] // unique index per source frame

await new Promise((resolve, reject) => {
	const ff = spawn('ffmpeg', [
		'-v', 'error', '-nostdin', '-i', input,
		'-map', '0:v:0', '-an', '-fps_mode', 'passthrough',
		'-vf', `scale=${AW}:${AH}:flags=area,format=gray`,
		'-f', 'rawvideo', '-pix_fmt', 'gray', '-',
	])
	let buf = Buffer.alloc(0)
	let last = null
	let n = 0
	ff.stdout.on('data', chunk => {
		buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
		while (buf.length >= frameBytes) {
			const frame = buf.subarray(0, frameBytes)
			buf = buf.subarray(frameBytes)
			let moved = 0
			if (last) {
				let n = 0
				for (let i = 0; i < frameBytes; i++) if (Math.abs(frame[i] - last[i]) > PIXEL_STEP) n++
				moved = (n / frameBytes) * 100
			}
			diffs.push(moved)
			if (!last || moved > THRESHOLD) {
				kept.push(n)
				last = Buffer.from(frame)
			}
			unique.push(kept.length - 1)
			n++
		}
	})
	let err = ''
	ff.stderr.on('data', d => (err += d))
	ff.on('error', reject)
	ff.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg (analyze) exited ${code}: ${err}`))))
})

const total = diffs.length
if (total === 0) {
	console.error('no frames decoded')
	process.exit(1)
}
if (expectFrames && expectFrames !== total) {
	console.error(`warning: decoded ${total} frames, container says ${expectFrames}`)
}

// Runs: one per unique frame, with the source frames it covered
const runs = kept.map((start, u) => {
	const end = (kept[u + 1] ?? total) - 1
	return {unique: u, from: start, to: end, hold: end - start + 1}
})

const dropped = diffs.filter((d, i) => i > 0 && !kept.includes(i))
const newOnes = kept.slice(1).map(i => diffs[i])
const maxDropped = dropped.length ? Math.max(...dropped) : null
const minKept = newOnes.length ? Math.min(...newOnes) : null

const fmt = x => (x === null ? '—' : x.toFixed(3))
console.log(`${path.basename(input)}: ${width}×${height}, ${srcFps.toFixed(3)} fps, ${total} frames`)
console.log(`unique frames: ${kept.length}  (dropped ${total - kept.length}, threshold ${THRESHOLD})`)
console.log(`pixels moved: dropped frames ≤ ${fmt(maxDropped)} %, new frames ≥ ${fmt(minKept)} %`)
if (maxDropped !== null && minKept !== null && minKept < maxDropped * 4) {
	console.log('warning: little margin between dropped and kept diffs — check with --analyze and adjust --threshold')
}
const holdHist = new Map()
for (const r of runs) holdHist.set(r.hold, (holdHist.get(r.hold) ?? 0) + 1)
console.log(
	'holds: ' +
		[...holdHist.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([h, c]) => `${h}f×${c}`)
			.join('  ')
)

if (ANALYZE) {
	console.log('\n unique  src frames   hold  moved %')
	for (const r of runs) {
		const range = r.from === r.to ? `${r.from}` : `${r.from}–${r.to}`
		console.log(`${String(r.unique).padStart(7)}  ${range.padEnd(11)}  ${String(r.hold).padStart(4)}  ${fmt(diffs[r.from])}`)
	}
	const near = diffs
		.map((d, i) => ({i, d}))
		.filter(({i, d}) => i > 0 && d > THRESHOLD / 4 && d < THRESHOLD * 4)
	if (near.length) {
		console.log(`\nframes near the threshold (${THRESHOLD / 4} … ${THRESHOLD * 4} % moved):`)
		for (const {i, d} of near) console.log(`  #${i}  ${fmt(d)}  ${kept.includes(i) ? 'kept' : 'dropped'}`)
	}
	process.exit(0)
}

//------------------------------------------------------------------------------
// Outputs

if (!FORCE) {
	for (const f of [outVideo, outRemap, outJson]) {
		try {
			await access(f)
			console.error(`${f} exists — pass --force to overwrite`)
			process.exit(1)
		} catch {
			/* fine */
		}
	}
}

// AE Keyframe Data. Units Per Second is the comp's (= the original's) rate;
// each comp frame i gets the source time of shot u(i) in a layer interpreted
// at OUT_FPS. Values are frame boundaries, like AE's own export.
const fpsLabel = +srcFps.toFixed(3)
const remapLines = [
	'Adobe After Effects 9.0 Keyframe Data',
	'',
	`\tUnits Per Second\t${fpsLabel}`,
	`\tSource Width\t${width}`,
	`\tSource Height\t${height}`,
	'\tSource Pixel Aspect Ratio\t1',
	'\tComp Pixel Aspect Ratio\t1',
	'',
	'Layer',
	'Time Remap',
	'\tFrame\tseconds\t',
]
for (let i = 0; i < total; i++) {
	remapLines.push(`\t${i}\t${+(unique[i] / OUT_FPS).toFixed(6)}\t`)
}
remapLines.push('', 'End of Keyframe Data', '')
await writeFile(outRemap, remapLines.join('\n'))

await writeFile(
	outJson,
	JSON.stringify(
		{
			source: {file: path.basename(input), width, height, fps: srcFps, frames: total},
			output: {file: path.basename(outVideo), fps: OUT_FPS, frames: kept.length},
			threshold: {movedPercent: THRESHOLD, pixelStep: PIXEL_STEP},
			unique, // source frame → unique (shot) index
			runs, // unique → {from, to, hold}
			movedPercent: diffs.map(d => +d.toFixed(3)),
		},
		null,
		'\t'
	)
)

// Pass 2: re-encode only the kept frames, consecutive at OUT_FPS.
// `select` takes an expression over the input frame index n; collapse
// consecutive kept frames into between() to keep it short.
const terms = []
for (let k = 0; k < kept.length; ) {
	let j = k
	while (j + 1 < kept.length && kept[j + 1] === kept[j] + 1) j++
	terms.push(j === k ? `eq(n\\,${kept[k]})` : `between(n\\,${kept[k]}\\,${kept[j]})`)
	k = j + 1
}
const proresProfiles = {Proxy: 0, LT: 1, Standard: 2, HQ: 3, 4444: 4, '4444 XQ': 5}
const profile = stream.codec_name === 'prores' && stream.profile in proresProfiles ? proresProfiles[stream.profile] : 3
const pixFmt = profile >= 4 ? (stream.pix_fmt?.includes('a') ? 'yuva444p10le' : 'yuv444p10le') : 'yuv422p10le'
await new Promise((resolve, reject) => {
	const ff = spawn(
		'ffmpeg',
		[
			'-v', 'error', '-nostdin', '-y', '-i', input,
			'-map', '0:v:0', '-an',
			'-vf', `select='${terms.join('+')}',setpts=N/(${OUT_FPS}*TB)`,
			'-fps_mode', 'cfr', '-r', String(OUT_FPS), // pts are already 0, 1, 2… at 1/fps: cfr neither dups nor drops
			'-c:v', 'prores_ks', '-profile:v', String(profile), '-pix_fmt', pixFmt,
			'-vendor', 'apl0',
			outVideo,
		],
		{stdio: ['ignore', 'inherit', 'pipe']}
	)
	let err = ''
	ff.stderr.on('data', d => (err += d))
	ff.on('error', reject)
	ff.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg (encode) exited ${code}: ${err}`))))
})

const {stdout: check} = await run('ffprobe', [
	'-v', 'error', '-select_streams', 'v:0', '-count_frames',
	'-show_entries', 'stream=nb_read_frames,r_frame_rate',
	'-of', 'json', outVideo,
])
const out = JSON.parse(check).streams[0]
const outFrames = Number(out.nb_read_frames)
if (outFrames !== kept.length) {
	console.error(`error: ${outVideo} has ${outFrames} frames, expected ${kept.length}`)
	process.exit(1)
}
console.log(`\nwrote ${outVideo}  (${outFrames} frames @ ${out.r_frame_rate})`)
console.log(`wrote ${outRemap}  (${total} keyframes, Units Per Second ${fpsLabel})`)
console.log(`wrote ${outJson}`)
