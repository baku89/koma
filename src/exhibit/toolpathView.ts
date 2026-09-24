/**
 * Annotated toolpath for the exhibition's G-CODE pane, after the catalogue
 * plate: hairline path, and the text of every LABEL_EVERY-th G-code line at
 * the end of the move it produced, in a slowly turning perspective view.
 *
 * Lines are drawn with WebGL (three.js LineSegments — the geometry is
 * uploaded once per file, so turning the view and swapping files at frame
 * rate cost nothing); the few labels go on a 2D canvas on top.
 */

import * as THREE from 'three'

import {type Toolpath} from '@/utils/fluidnc'

export interface ToolpathScene {
	toolpath: Toolpath
	lines: string[]
}

/** One label every this many G-code lines (plus the header). */
export const LABEL_EVERY = 200

export interface ToolpathColors {
	font: string
	color: string
	dim: string
	accent: string
}

interface Label {
	line: number
	text: string
	position: THREE.Vector3
	rapid: boolean
}

function cutBounds(tp: Toolpath) {
	const box = new THREE.Box3()
	const v = new THREE.Vector3()
	for (const seg of tp.segments) {
		if (seg.rapid) continue
		box.expandByPoint(v.set(seg.from[0], seg.from[2], -seg.from[1]))
		box.expandByPoint(v.set(seg.to[0], seg.to[2], -seg.to[1]))
	}
	if (box.isEmpty()) {
		for (const seg of tp.segments) {
			box.expandByPoint(v.set(seg.from[0], seg.from[2], -seg.from[1]))
			box.expandByPoint(v.set(seg.to[0], seg.to[2], -seg.to[1]))
		}
	}
	return box
}

export class ToolpathRenderer {
	#renderer: THREE.WebGLRenderer
	#scene = new THREE.Scene()
	#camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100000)
	#lines: THREE.LineSegments | null = null
	#labels: Label[] = []
	#centre = new THREE.Vector3()
	#radius = 1
	#labelCanvas: HTMLCanvasElement
	#colors: ToolpathColors
	#projected = new THREE.Vector3()

	constructor(gl: HTMLCanvasElement, labels: HTMLCanvasElement, colors: ToolpathColors) {
		this.#renderer = new THREE.WebGLRenderer({canvas: gl, antialias: true, alpha: true})
		this.#renderer.setClearColor(0x000000, 0)
		this.#labelCanvas = labels
		this.#colors = colors
	}

	setScene(scene: ToolpathScene | null, sentLines = -1) {
		if (this.#lines) {
			this.#scene.remove(this.#lines)
			this.#lines.geometry.dispose()
			;(this.#lines.material as THREE.Material).dispose()
			this.#lines = null
		}
		this.#labels = []
		if (!scene || scene.toolpath.segments.length === 0) return

		const {toolpath, lines} = scene
		const n = toolpath.segments.length
		const pos = new Float32Array(n * 6)
		const col = new Float32Array(n * 6)
		const cCut = new THREE.Color(this.#colors.color)
		const cDim = new THREE.Color(this.#colors.dim)
		const cDone = new THREE.Color(this.#colors.accent)
		const endOf = new Map<number, {to: [number, number, number]; rapid: boolean}>()
		toolpath.segments.forEach((seg, i) => {
			// mill X right, Y away, Z up → three x, y(up), -z
			pos[i * 6] = seg.from[0]
			pos[i * 6 + 1] = seg.from[2]
			pos[i * 6 + 2] = -seg.from[1]
			pos[i * 6 + 3] = seg.to[0]
			pos[i * 6 + 4] = seg.to[2]
			pos[i * 6 + 5] = -seg.to[1]
			const c = seg.line < sentLines ? cDone : seg.rapid ? cDim : cCut
			// Alpha isn't per-vertex here; rapids are dimmed by colour instead.
			for (let k = 0; k < 2; k++) {
				col[i * 6 + k * 3] = c.r
				col[i * 6 + k * 3 + 1] = c.g
				col[i * 6 + k * 3 + 2] = c.b
			}
			endOf.set(seg.line, {to: seg.to, rapid: seg.rapid})
		})
		const geo = new THREE.BufferGeometry()
		geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
		geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
		this.#lines = new THREE.LineSegments(
			geo,
			new THREE.LineBasicMaterial({vertexColors: true, transparent: true, opacity: 0.6})
		)
		this.#scene.add(this.#lines)

		const box = cutBounds(toolpath)
		box.getCenter(this.#centre)
		this.#radius = Math.max(1, box.getSize(new THREE.Vector3()).length() / 2)

		for (const [line, e] of endOf) {
			if (line % LABEL_EVERY !== 0) continue
			this.#labels.push({
				line,
				text: lines[line] ?? '',
				position: new THREE.Vector3(e.to[0], e.to[2], -e.to[1]),
				rapid: e.rapid,
			})
		}
		// Header lines (before the first move) stack at the start point.
		const first = toolpath.segments[0]
		for (let i = 0; i < first.line && i < 12; i++) {
			this.#labels.push({
				line: -(first.line - i),
				text: lines[i] ?? '',
				position: new THREE.Vector3(first.from[0], first.from[2], -first.from[1]),
				rapid: true,
			})
		}
	}

	render(timeSec: number, sentLines = -1) {
		const gl = this.#renderer.domElement
		const w = gl.clientWidth
		const h = gl.clientHeight
		if (w === 0 || h === 0) return
		const dpr = Math.min(2, window.devicePixelRatio || 1)
		if (gl.width !== Math.round(w * dpr) || gl.height !== Math.round(h * dpr)) {
			this.#renderer.setPixelRatio(dpr)
			this.#renderer.setSize(w, h, false)
			this.#camera.aspect = w / h
			this.#camera.updateProjectionMatrix()
		}

		// Slow orbit around the vertical axis, looking down at ~30°.
		const yaw = timeSec * 0.12
		const dist = this.#radius * 2.5
		this.#camera.position.set(
			this.#centre.x + dist * Math.cos(0.5) * Math.sin(yaw),
			this.#centre.y + dist * Math.sin(0.5),
			this.#centre.z + dist * Math.cos(0.5) * Math.cos(yaw)
		)
		this.#camera.lookAt(this.#centre)
		this.#camera.near = dist * 0.05
		this.#camera.far = dist * 4
		this.#camera.updateProjectionMatrix()
		this.#renderer.render(this.#scene, this.#camera)

		// Labels
		const lc = this.#labelCanvas
		if (lc.width !== Math.round(w * dpr) || lc.height !== Math.round(h * dpr)) {
			lc.width = Math.round(w * dpr)
			lc.height = Math.round(h * dpr)
		}
		const ctx = lc.getContext('2d')
		if (!ctx) return
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
		ctx.clearRect(0, 0, w, h)
		ctx.font = `9px ${this.#colors.font}`
		ctx.textBaseline = 'middle'
		ctx.globalAlpha = 0.85
		for (const l of this.#labels) {
			this.#projected.copy(l.position).project(this.#camera)
			if (this.#projected.z > 1) continue
			const x = ((this.#projected.x + 1) / 2) * w
			let y = ((1 - this.#projected.y) / 2) * h
			if (l.line < 0) y += 11 * l.line // header stack, upward
			ctx.fillStyle =
				l.line >= 0 && l.line < sentLines
					? this.#colors.accent
					: l.rapid
						? this.#colors.dim
						: this.#colors.color
			ctx.fillText(l.text, x + 4, y)
		}
		ctx.globalAlpha = 1
	}

	dispose() {
		this.setScene(null)
		this.#renderer.dispose()
	}
}
