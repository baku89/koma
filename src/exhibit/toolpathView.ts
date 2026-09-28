/**
 * Annotated toolpath for the exhibition's G-CODE pane, after the catalogue
 * plate: hairline path, and the text of every LABEL_EVERY-th G-code line at
 * the end of the move it produced, in a slowly turning perspective view.
 *
 * Lines are drawn with WebGL (three.js LineSegments). The file is parsed in
 * a worker (toolpath.worker.ts) into flat typed arrays that are uploaded as
 * they are; the progress highlight while the mill is cutting only rewrites
 * the colour attribute. The few labels go on a 2D canvas on top.
 */

import * as THREE from 'three'

import type {CompactToolpath, ToolpathLabel} from './toolpath.worker'

export {LABEL_EVERY} from './toolpath.worker'

export interface ToolpathColors {
	font: string
	color: string
	dim: string
	accent: string
}

export class ToolpathRenderer {
	#renderer: THREE.WebGLRenderer
	#scene = new THREE.Scene()
	#camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100000)
	#lines: THREE.LineSegments | null = null
	#colorAttr: THREE.BufferAttribute | null = null
	#toolpath: CompactToolpath | null = null
	#sentLines = -1
	#labels: ToolpathLabel[] = []
	#centre = new THREE.Vector3()
	#radius = 1
	#labelCanvas: HTMLCanvasElement
	#colors: ToolpathColors
	#rgb: {cut: THREE.Color; dim: THREE.Color; done: THREE.Color}
	#projected = new THREE.Vector3()
	#labelPos = new THREE.Vector3()

	constructor(gl: HTMLCanvasElement, labels: HTMLCanvasElement, colors: ToolpathColors) {
		this.#renderer = new THREE.WebGLRenderer({canvas: gl, antialias: true, alpha: true})
		this.#renderer.setClearColor(0x000000, 0)
		this.#labelCanvas = labels
		this.#colors = colors
		this.#rgb = {
			cut: new THREE.Color(colors.color),
			dim: new THREE.Color(colors.dim),
			done: new THREE.Color(colors.accent),
		}
	}

	setScene(toolpath: CompactToolpath | null, sentLines = -1) {
		if (this.#lines) {
			this.#scene.remove(this.#lines)
			this.#lines.geometry.dispose()
			;(this.#lines.material as THREE.Material).dispose()
			this.#lines = null
			this.#colorAttr = null
		}
		this.#toolpath = toolpath
		this.#labels = toolpath?.labels ?? []
		this.#sentLines = sentLines
		if (!toolpath) return

		const n = toolpath.rapid.length
		const geo = new THREE.BufferGeometry()
		geo.setAttribute('position', new THREE.BufferAttribute(toolpath.positions, 3))
		this.#colorAttr = new THREE.BufferAttribute(new Float32Array(n * 6), 3)
		this.#colorAttr.setUsage(THREE.DynamicDrawUsage)
		geo.setAttribute('color', this.#colorAttr)
		this.#fillColors()
		this.#lines = new THREE.LineSegments(
			geo,
			new THREE.LineBasicMaterial({vertexColors: true, transparent: true, opacity: 0.6})
		)
		this.#lines.frustumCulled = false
		this.#scene.add(this.#lines)

		this.#centre.set(...toolpath.centre)
		this.#radius = toolpath.radius
	}

	/** Lines already sent to the mill (−1 = not cutting). Colour-only update. */
	setSent(sentLines: number) {
		if (sentLines === this.#sentLines) return
		this.#sentLines = sentLines
		if (this.#toolpath && this.#colorAttr) {
			this.#fillColors()
			this.#colorAttr.needsUpdate = true
		}
	}

	#fillColors() {
		const tp = this.#toolpath
		const attr = this.#colorAttr
		if (!tp || !attr) return
		const col = attr.array as Float32Array
		const sent = this.#sentLines
		const {cut, dim, done} = this.#rgb
		const n = tp.rapid.length
		for (let i = 0; i < n; i++) {
			const c = tp.line[i] < sent ? done : tp.rapid[i] ? dim : cut
			const o = i * 6
			col[o] = c.r
			col[o + 1] = c.g
			col[o + 2] = c.b
			col[o + 3] = c.r
			col[o + 4] = c.g
			col[o + 5] = c.b
		}
	}

	render(timeSec: number) {
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
		const sent = this.#sentLines
		for (const l of this.#labels) {
			this.#projected.copy(this.#labelPos.set(...l.position)).project(this.#camera)
			if (this.#projected.z > 1) continue
			const x = ((this.#projected.x + 1) / 2) * w
			let y = ((1 - this.#projected.y) / 2) * h
			if (l.line < 0) y += 11 * l.line // header stack, upward
			ctx.fillStyle =
				l.line >= 0 && l.line < sent
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
