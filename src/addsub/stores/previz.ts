/**
 * Reads what Houdini writes into the project's `previz/` folder (ADDSUB.md
 * §13.1). koma never writes there.
 *
 * previz/frames.json (proposed v1 — see ADDSUB.md "実装メモ"):
 *   {
 *     "version": 1,
 *     "fps": 18,
 *     "paths": {"gcode": "gcode/%04d.nc", "led": "led/%04d.png",
 *               "render": "render/%04d.jpg"},          // optional defaults
 *     "ledTopFilmY": 1500,                              // optional
 *     "frames": [
 *       {"frame": 1,
 *        "camera": {"position": [x, y, z],              // film mm, pupil
 *                   "rotation": [x, y, z, w]            // quaternion, or
 *                   /* "angles": {"tilt": a, "pan": b, "roll": c} deg *\/},
 *        "cameraConfigs": {"aperture": 8},              // optional
 *        "gcode": "gcode/0001.nc", "led": "led/0001.png", "render": "render/0001.jpg",
 *        "cut": true}                                   // false = no cutting this frame
 *     ]
 *   }
 *
 * Changes are picked up with FileSystemObserver when available, else by
 * polling frames.json's modification time. A half-written file (Dropbox or
 * Houdini mid-write) fails to parse and is retried shortly after.
 */

import type {quat, vec3} from 'linearly'
import {defineStore} from 'pinia'
import type {ConfigType} from 'tethr'
import {computed, readonly, ref, shallowRef, watch} from 'vue'

import {useProjectStore} from '@/stores/project'

import {anglesToRotation, type CameraPose, type HeadAngles} from '../kinematics'

export const PREVIZ_DIR = 'previz'
const FRAMES_FILE = 'frames.json'
const POLL_MS = 3000

export interface PrevizFrameRaw {
	frame: number
	camera?: {
		position: vec3
		rotation?: quat
		angles?: HeadAngles
	}
	cameraConfigs?: Partial<ConfigType>
	gcode?: string
	led?: string
	render?: string
	cut?: boolean
}

export interface PrevizFile {
	version: number
	fps?: number
	paths?: {gcode?: string; led?: string; render?: string}
	ledTopFilmY?: number
	frames: PrevizFrameRaw[]
}

export interface PrevizFrame {
	frame: number
	pose: CameraPose | null
	cameraConfigs?: Partial<ConfigType>
	/** Paths relative to previz/ (resolved from the defaults when omitted). */
	gcode: string | null
	led: string | null
	render: string | null
}

const DEFAULT_PATHS = {
	gcode: 'gcode/%04d.nc',
	led: 'led/%04d.png',
	render: 'render/%04d.jpg',
}

function expandPath(pattern: string, frame: number) {
	return pattern.replace(/%0?(\d*)d/, (_, w) =>
		String(frame).padStart(Number(w || 0), '0')
	)
}

function normalizeFrame(raw: PrevizFrameRaw, file: PrevizFile): PrevizFrame {
	const paths = {...DEFAULT_PATHS, ...file.paths}
	const pose: CameraPose | null = raw.camera
		? {
				position: raw.camera.position,
				rotation: raw.camera.rotation
					? raw.camera.rotation
					: raw.camera.angles
						? anglesToRotation(raw.camera.angles)
						: [0, 0, 0, 1],
			}
		: null
	const cut = raw.cut !== false
	return {
		frame: raw.frame,
		pose,
		cameraConfigs: raw.cameraConfigs,
		gcode: cut ? (raw.gcode ?? expandPath(paths.gcode, raw.frame)) : null,
		led: raw.led ?? expandPath(paths.led, raw.frame),
		render: raw.render ?? expandPath(paths.render, raw.frame),
	}
}

export const usePrevizStore = defineStore('addsub:previz', () => {
	const project = useProjectStore()

	const dir = shallowRef<FileSystemDirectoryHandle | null>(null)
	const file = ref<PrevizFile | null>(null)
	const frames = ref(new Map<number, PrevizFrame>())
	const lastModified = ref<number | null>(null)
	const error = ref<string | null>(null)
	const loading = ref(false)

	const available = computed(() => dir.value !== null)
	const frameCount = computed(() => frames.value.size)
	const frameRange = computed<[number, number] | null>(() => {
		if (frames.value.size === 0) return null
		const keys = [...frames.value.keys()]
		return [Math.min(...keys), Math.max(...keys)]
	})

	//--------------------------------------------------------------------------
	// Folder resolution + watching

	let observer: {disconnect(): void} | null = null
	let pollTimer: ReturnType<typeof setInterval> | null = null

	async function attach() {
		detach()
		const root = project.directoryHandle
		if (!root) {
			dir.value = null
			return
		}
		try {
			dir.value = await root.getDirectoryHandle(PREVIZ_DIR)
		} catch {
			dir.value = null
			file.value = null
			frames.value = new Map()
			return
		}
		await reload()

		const FSO = (globalThis as any).FileSystemObserver
		if (typeof FSO === 'function') {
			try {
				const obs = new FSO(() => void reload())
				await obs.observe(dir.value, {recursive: false})
				observer = obs
			} catch {
				observer = null
			}
		}
		if (!observer) {
			pollTimer = setInterval(() => void reloadIfChanged(), POLL_MS)
		}
	}

	function detach() {
		observer?.disconnect()
		observer = null
		if (pollTimer) clearInterval(pollTimer)
		pollTimer = null
	}

	watch(() => project.directoryHandle, () => void attach(), {immediate: true})

	async function statFrames(): Promise<File | null> {
		if (!dir.value) return null
		try {
			const h = await dir.value.getFileHandle(FRAMES_FILE)
			return await h.getFile()
		} catch {
			return null
		}
	}

	async function reloadIfChanged() {
		const f = await statFrames()
		if (!f) {
			if (file.value) {
				file.value = null
				frames.value = new Map()
			}
			return
		}
		if (f.lastModified !== lastModified.value) await reload(f)
	}

	let reloadSeq = 0

	async function reload(prefetched?: File) {
		const seq = ++reloadSeq
		loading.value = true
		try {
			for (let attempt = 0; attempt < 5; attempt++) {
				const f = prefetched ?? (await statFrames())
				prefetched = undefined
				if (!f) {
					file.value = null
					frames.value = new Map()
					lastModified.value = null
					error.value = null
					return
				}
				try {
					const parsed = JSON.parse(await f.text()) as PrevizFile
					if (seq !== reloadSeq) return // superseded
					if (!Array.isArray(parsed.frames)) throw new Error('frames[] missing')
					file.value = parsed
					frames.value = new Map(
						parsed.frames.map(raw => [raw.frame, normalizeFrame(raw, parsed)])
					)
					lastModified.value = f.lastModified
					error.value = null
					return
				} catch (e) {
					// Probably mid-write: wait and retry.
					error.value = e instanceof Error ? e.message : String(e)
					await new Promise(r => setTimeout(r, 400))
				}
			}
		} finally {
			if (seq === reloadSeq) loading.value = false
		}
	}

	//--------------------------------------------------------------------------
	// Access

	/** previz frame for a timeline frame (applies the project's offset). */
	function frameFor(timelineFrame: number): PrevizFrame | null {
		return frames.value.get(timelineFrame + project.addsub.previzFrameOffset) ?? null
	}

	async function getFileHandle(rel: string): Promise<FileSystemFileHandle> {
		if (!dir.value) throw new Error('previz/ folder is not available')
		const parts = rel.split('/').filter(Boolean)
		let d = dir.value
		for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p)
		return d.getFileHandle(parts[parts.length - 1])
	}

	async function readBlob(rel: string): Promise<Blob> {
		const h = await getFileHandle(rel)
		const f = await h.getFile()
		// Detach from the file so later writes by Houdini/Dropbox can't
		// invalidate a Blob we're still using.
		return new Blob([await f.arrayBuffer()], {type: f.type})
	}

	async function readText(rel: string): Promise<string> {
		const h = await getFileHandle(rel)
		return (await h.getFile()).text()
	}

	async function exists(rel: string): Promise<boolean> {
		try {
			await getFileHandle(rel)
			return true
		} catch {
			return false
		}
	}

	return {
		available,
		file: readonly(file),
		frames: readonly(frames),
		frameCount,
		frameRange,
		lastModified: readonly(lastModified),
		error: readonly(error),
		loading: readonly(loading),
		ledTopFilmY: computed(() => file.value?.ledTopFilmY ?? null),
		frameFor,
		readBlob,
		readText,
		exists,
		reload: () => reload(),
	}
})
