/**
 * Video frames through ffmpeg, for koma's "drop a clip on the timeline"
 * (src/utils/videoFrames.ts). A browser decodes only its own codecs and the
 * guide clips are ProRes, so this process runs ffmpeg and streams the frames
 * back over the tools bridge's HTTP server:
 *
 *   POST /video            JSON {path} (the desktop app knows the file's
 *                          path) or the file's bytes (a browser tab: header
 *                          x-koma-name for the name) → {id, frames, fps, …}
 *   GET  /video/<id>       the frames as one MJPEG stream, one picture per
 *                          *stored* frame whatever the clip's rate
 *                          (`-fps_mode passthrough`); the reader splits it on
 *                          the JPEG markers. HTTP back-pressure holds ffmpeg
 *                          when the reader is slow — nothing is buffered ahead.
 *   DELETE /video/<id>     stop and forget (an uploaded copy is removed)
 *
 * ffmpeg is not bundled: PATH, the usual Homebrew / MacPorts / local prefixes
 * (a GUI app on macOS does not inherit the shell's PATH), or KOMA_FFMPEG /
 * KOMA_FFPROBE.
 */
import {execFile, spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {accessSync, constants, createWriteStream} from 'node:fs'
import {unlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {pipeline} from 'node:stream/promises'

const EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin']

function findBinary(name, envVar) {
	if (process.env[envVar]) return process.env[envVar]
	const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...EXTRA_DIRS]
	for (const dir of dirs) {
		if (!dir) continue
		const p = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name)
		try {
			accessSync(p, constants.X_OK)
			return p
		} catch {
			// next
		}
	}
	return null
}

let ffmpegPath
let ffprobePath

export function ffmpegBinary() {
	if (ffmpegPath === undefined) ffmpegPath = findBinary('ffmpeg', 'KOMA_FFMPEG')
	return ffmpegPath
}

export function ffprobeBinary() {
	if (ffprobePath === undefined) ffprobePath = findBinary('ffprobe', 'KOMA_FFPROBE')
	return ffprobePath
}

function parseRate(r) {
	if (!r) return null
	const [n, d] = r.split('/').map(Number)
	if (!Number.isFinite(n) || n <= 0) return null
	if (d === undefined) return n
	return Number.isFinite(d) && d > 0 ? n / d : null
}

/** @returns {Promise<{frames: number|null, fps: number|null, width: number, height: number, codec: string, duration: number|null}>} */
export async function probeVideo(file) {
	const ffprobe = ffprobeBinary()
	if (!ffprobe) throw new Error('ffprobe was not found (install ffmpeg, e.g. `brew install ffmpeg`)')
	const out = await new Promise((resolve, reject) => {
		execFile(
			ffprobe,
			[
				'-v', 'error',
				'-select_streams', 'v:0',
				'-show_entries',
				'stream=codec_name,width,height,nb_frames,r_frame_rate,avg_frame_rate,duration:format=duration',
				'-of', 'json',
				file,
			],
			{maxBuffer: 1 << 20},
			(err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout))
		)
	})
	const json = JSON.parse(out)
	const s = json.streams?.[0]
	if (!s || !s.width || !s.height) throw new Error('No video stream in the file')
	const fps = parseRate(s.avg_frame_rate) ?? parseRate(s.r_frame_rate)
	const duration = Number(s.duration ?? json.format?.duration)
	let frames = Number(s.nb_frames)
	if (!Number.isFinite(frames) || frames <= 0) {
		frames = fps && Number.isFinite(duration) ? Math.round(duration * fps) : NaN
	}
	return {
		frames: Number.isFinite(frames) && frames > 0 ? frames : null,
		fps,
		width: s.width,
		height: s.height,
		codec: s.codec_name ?? '',
		duration: Number.isFinite(duration) ? duration : null,
	}
}

/** ffmpeg writing the clip's frames as MJPEG to stdout. */
export function spawnFrameStream(file) {
	const ffmpeg = ffmpegBinary()
	if (!ffmpeg) throw new Error('ffmpeg was not found (install it, e.g. `brew install ffmpeg`)')
	return spawn(
		ffmpeg,
		[
			'-nostdin', '-hide_banner', '-loglevel', 'error',
			'-i', file,
			'-map', '0:v:0',
			'-fps_mode', 'passthrough',
			'-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '2',
			'pipe:1',
		],
		{stdio: ['ignore', 'pipe', 'pipe']}
	)
}

/**
 * The HTTP side: clips registered by id, each either a path the client gave
 * or an upload kept in the temp folder until DELETE / stop.
 */
export function createVideoRoutes({log = () => {}} = {}) {
	/** @type {Map<string, {path: string, temp: boolean, name: string, proc: import('node:child_process').ChildProcess | null}>} */
	const clips = new Map()

	async function forget(id) {
		const clip = clips.get(id)
		if (!clip) return false
		clips.delete(id)
		if (clip.proc && clip.proc.exitCode === null) clip.proc.kill('SIGKILL')
		if (clip.temp) await unlink(clip.path).catch(() => {})
		return true
	}

	async function register(req) {
		const id = randomUUID()
		const type = req.headers['content-type'] ?? ''
		let clip
		if (type.includes('application/json')) {
			const chunks = []
			for await (const c of req) chunks.push(c)
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
			if (typeof body.path !== 'string' || !body.path) throw new Error('"path" is required')
			clip = {path: body.path, temp: false, name: path.basename(body.path), proc: null}
		} else {
			const name = String(req.headers['x-koma-name'] ?? 'clip')
			const ext = path.extname(name) || '.mov'
			const file = path.join(tmpdir(), `koma-video-${id}${ext}`)
			await pipeline(req, createWriteStream(file))
			clip = {path: file, temp: true, name, proc: null}
		}
		try {
			const info = await probeVideo(clip.path)
			clips.set(id, clip)
			log('video', `${clip.name}: ${info.codec} ${info.width}×${info.height}, ${info.frames ?? '?'} frames${clip.temp ? ' (uploaded)' : ''}`)
			return {id, name: clip.name, ...info}
		} catch (e) {
			if (clip.temp) await unlink(clip.path).catch(() => {})
			throw e
		}
	}

	/** Returns true when it handled the request. */
	async function handle(req, res, pathname, cors, json) {
		if (pathname === '/video' && req.method === 'POST') {
			if (!ffmpegBinary() || !ffprobeBinary()) {
				json(res, 503, {ok: false, error: 'ffmpeg / ffprobe not found (brew install ffmpeg)'})
				return true
			}
			try {
				json(res, 200, {ok: true, ...(await register(req))})
			} catch (e) {
				json(res, 400, {ok: false, error: e?.message ?? String(e)})
			}
			return true
		}
		const m = /^\/video\/([\w-]+)$/.exec(pathname)
		if (!m) return false
		const clip = clips.get(m[1])
		if (!clip) {
			json(res, 404, {ok: false, error: 'no such clip'})
			return true
		}
		if (req.method === 'DELETE') {
			await forget(m[1])
			json(res, 200, {ok: true})
			return true
		}
		if (req.method !== 'GET') return false
		if (clip.proc && clip.proc.exitCode === null) clip.proc.kill('SIGKILL')
		const proc = spawnFrameStream(clip.path)
		clip.proc = proc
		let stderr = ''
		proc.stderr.on('data', c => (stderr += c.toString()))
		proc.on('close', code => {
			if (code && code !== null) log('video', `${clip.name}: ffmpeg exited with ${code}${stderr ? `: ${stderr.trim()}` : ''}`, 'error')
		})
		res.writeHead(200, {'content-type': 'video/x-motion-jpeg', 'cache-control': 'no-store', ...cors})
		// pipe() applies back-pressure: ffmpeg waits while the reader is busy.
		proc.stdout.pipe(res)
		res.on('close', () => {
			if (proc.exitCode === null) proc.kill('SIGKILL')
		})
		return true
	}

	async function stop() {
		for (const id of [...clips.keys()]) await forget(id)
	}

	return {handle, stop, clips}
}
