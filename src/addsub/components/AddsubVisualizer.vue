<script setup lang="ts">
/**
 * 3D view of the set (ADDSUB.md §11): LED wall, block stack on the mill, the
 * mill head, the camera at its current rig pose, the trajectory of captured
 * frames and the previz path ahead. Six clickable arrows on the camera and
 * three on the mill head jog the machines by the panel's step.
 *
 * Scene units are metres (world mm / 1000).
 */
import {useElementSize} from '@vueuse/core'
import {mat4, quat, vec3} from 'linearly'
import * as THREE from 'three'
import type {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js'
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
	AmbientLight,
	BasicMaterial,
	Camera,
	Cone,
	FbxModel,
	Group,
	PointLight,
	Renderer,
	Scene,
} from 'troisjs'
import {InputRadio, useTweeq} from 'tweeq'
import {computed, onMounted, onUnmounted, ref, shallowRef, watch} from 'vue'

import {useProjectStore} from '@/stores/project'
import {useViewportStore} from '@/stores/viewport'
import type {AxesPosition, Axis} from '@/utils/fluidnc'
import type {CompactToolpath} from '@/utils/fluidnc/toolpath.worker'

import {filmOriginMill, filmToWorld, millToWorld, tableShiftWorld} from '../coords'
import {orbitRigAxes, rigAxesToCameraPose} from '../kinematics'
import {ledBottomY} from '../led/layout'
import {effectivePlanFor, type FramePlan, interpolatedFrames, planFor, plannedFrames} from '../plan'
import {useLedStore} from '../stores/led'
import {useMillStore, useRigStore} from '../stores/machines'
import {usePrevizStore} from '../stores/previz'
import {useSequenceStore} from '../stores/sequence'

const Tq = useTweeq()
const project = useProjectStore()
const viewport = useViewportStore()
const mill = useMillStore()
const rig = useRigStore()
const led = useLedStore()
const previz = usePrevizStore()
const sequence = useSequenceStore()

const S = 0.001 // mm → m

const cal = computed(() => project.addsub.calibration)
const filmLift = computed(() => project.addsub.filmLift)

//------------------------------------------------------------------------------
// Poses

/** Current camera pose (world) from the rig's reported axes. */
const cameraPoseWorld = computed(() => {
	const pose = rigAxesToCameraPose(rig.mpos, filmLift.value, cal.value)
	return {
		position: filmToWorld(pose.position, filmLift.value, cal.value.filmOriginWorld),
		rotation: pose.rotation,
	}
})

const cameraObject = computed(() => matrixToThree(
	mat4.fromRotationTranslation(
		cameraPoseWorld.value.rotation,
		vec3.scale(cameraPoseWorld.value.position, S)
	)
))

/** Tool tip and block stack in world (see coords.ts). */
const tableShift = computed(() =>
	tableShiftWorld(mill.mpos, project.addsub.shootPosition)
)

const toolTipWorld = computed(() => {
	const m = mill.mpos
	const p = millToWorld([m.x ?? 0, m.y ?? 0, m.z ?? 0], cal.value.millOffset)
	return vec3.add(p, tableShift.value)
})

const blockOriginWorld = computed(() =>
	vec3.add(filmToWorld([0, 0, 0], 0, cal.value.filmOriginWorld), tableShift.value)
)

// Nominal block for display (mm): the project's block height; the footprint
// isn't specified, so draw a cube. Two blocks high = the mill's max stack.
const blockHeight = computed(() => project.addsub.blockHeight)

//------------------------------------------------------------------------------
// LED wall outline

const wall = computed(() => {
	const p = project.addsub.led.layout
	const top = p.topY * S
	const bottom = ledBottomY(p) * S
	return {top, bottom, hx: (p.sizeX / 2) * S, hz: (p.sizeZ / 2) * S}
})

//------------------------------------------------------------------------------
// Renderer plumbing

const cameraControlPosition = Tq.config.ref('addsub.view.position', vec3.of(3, 2.5, 3))
const cameraControlTarget = Tq.config.ref('addsub.view.target', vec3.of(0, 0.8, 0))

let renderer: THREE.WebGLRenderer
let camera: THREE.PerspectiveCamera
let cameraCtrl: OrbitControls | undefined

const $root = shallowRef<HTMLElement | null>(null)
const $guide = shallowRef<any>()
const $lines = shallowRef<any>()
const rootSize = useElementSize($root)

watch([rootSize.width, rootSize.height], ([w, h]) => {
	if (!renderer || !camera) return
	renderer.setSize(w, h)
	camera.aspect = w / h
	camera.updateProjectionMatrix()
})

function onLoadCameraModel(group: THREE.Group) {
	const mesh = group.children[0] as THREE.Mesh
	const material = mesh.material as THREE.MeshPhongMaterial
	material.opacity = 0.6
	material.transparent = true
}

function onRendererReady(trois: any) {
	const cameraControl: OrbitControls = trois.three.cameraCtrl
	cameraCtrl = cameraControl
	renderer = trois.three.renderer
	camera = cameraControl.object as THREE.PerspectiveCamera
	camera.position.set(...cameraControlPosition.value)
	cameraControl.target.set(...cameraControlTarget.value)
	cameraControl.addEventListener('end', () => {
		cameraControlPosition.value = camera.position.toArray()
		cameraControlTarget.value = cameraControl.target.toArray() as vec3
	})


	const guide: THREE.Group = $guide.value.group
	guide.add(new THREE.GridHelper(4, 40, 0x555555, 0x333333))
	guide.add(new THREE.AxesHelper(0.5))
	guide.add(outline)
}

//------------------------------------------------------------------------------
// Set geometry from previz/set.json (glTF exported by Houdini, mm). While
// none is loaded, the parametric wall outline stands in.

const outline = new THREE.Group()
const setGroup = new THREE.Group()
setGroup.scale.setScalar(S)

onMounted(() => {
	$lines.value?.add(setGroup)
	outline.add(wallOutline())
})

const gltfLoader = new GLTFLoader()
let geometrySeq = 0

watch(
	() => [previz.setGeometry, previz.setModified] as const,
	async ([list]) => {
		const seq = ++geometrySeq
		setGroup.clear()
		outline.visible = list.length === 0
		for (const g of list) {
			try {
				const blob = await previz.readBlob(g.file)
				const gltf = await gltfLoader.parseAsync(await blob.arrayBuffer(), '')
				if (seq !== geometrySeq) return
				const color = new THREE.Color(g.color ?? '#888888')
				gltf.scene.traverse(obj => {
					const mesh = obj as THREE.Mesh
					if (!mesh.isMesh) return
					mesh.material = new THREE.MeshBasicMaterial({
						color,
						wireframe: g.wireframe ?? true,
						transparent: true,
						opacity: g.opacity ?? 0.6,
					})
				})
				setGroup.add(gltf.scene)
			} catch (e) {
				// eslint-disable-next-line no-console
				console.warn('[set.json] failed to load geometry', g.file, e)
			}
		}
	},
	{immediate: true}
)

function wallOutline() {
	const {top, bottom, hx, hz} = wall.value
	const pts: THREE.Vector3[] = []
	for (const y of [top, bottom]) {
		const ring = [
			[-hx, y, hz],
			[-hx, y, -hz],
			[hx, y, -hz],
			[hx, y, hz],
			[-hx, y, hz],
		]
		for (let i = 0; i < ring.length - 1; i++) {
			pts.push(new THREE.Vector3(...ring[i]), new THREE.Vector3(...ring[i + 1]))
		}
	}
	for (const [x, z] of [
		[-hx, hz],
		[-hx, -hz],
		[hx, -hz],
		[hx, hz],
	]) {
		pts.push(new THREE.Vector3(x, top, z), new THREE.Vector3(x, bottom, z))
	}
	const geo = new THREE.BufferGeometry().setFromPoints(pts)
	return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({color: 0x666666}))
}

//------------------------------------------------------------------------------
// Trajectories (captured frames + previz ahead), as raw three lines

const shotLine = new THREE.Line(
	new THREE.BufferGeometry(),
	new THREE.LineBasicMaterial({color: 0xffffff})
)
const previzLine = new THREE.Line(
	new THREE.BufferGeometry(),
	new THREE.LineBasicMaterial({color: 0xff6666})
)
// Planned rig poses on the capture layer (plan.ts): a dashed line through the
// frames that have a plan, so a move can be checked before anything moves.
const planLine = new THREE.Line(
	new THREE.BufferGeometry(),
	new THREE.LineDashedMaterial({color: 0x66aaff, dashSize: 0.03, gapSize: 0.02})
)
// One dot per planned frame: a short move (tens of mm) is invisible as a line.
const planPoints = new THREE.Points(
	new THREE.BufferGeometry(),
	new THREE.PointsMaterial({color: 0x66aaff, size: 0.015})
)
// Smaller, fainter dots for the frames interpolated between planned ones
// (plan.ts effectivePlanFor): one per frame the sequence will shoot.
const planInterpPoints = new THREE.Points(
	new THREE.BufferGeometry(),
	new THREE.PointsMaterial({color: 0x66aaff, size: 0.007, transparent: true, opacity: 0.6})
)
const ledPoints = new THREE.Points(
	new THREE.BufferGeometry(),
	new THREE.PointsMaterial({size: 0.012, vertexColors: true})
)

onMounted(() => {
	const g = $lines.value
	if (!g) return
	g.add(shotLine)
	g.add(previzLine)
	g.add(planLine)
	g.add(planPoints)
	g.add(planInterpPoints)
	g.add(ledPoints)
	g.add(toolpathGroup)
})

//------------------------------------------------------------------------------
// Toolpath of the cut ahead (cuts.ts): the capture frame's G-code, or the one
// streaming right now, drawn where it will run — the file's coordinates are
// mill axes about the work zero (G54), so the group sits at that origin and
// follows the table. Rapids dim,
// cutting moves white, lines already sent to the mill in blue. The mill's
// tool tip (above) is the "current position" marker, like cncjs.

const TOOLPATH_COLORS = {
	cut: new THREE.Color(0xdddddd),
	rapid: new THREE.Color(0x555555),
	done: new THREE.Color(0x66aaff),
}

const toolpathGroup = new THREE.Group()
// Worker output is in three.js axes (mill X → x, mill Z → y, mill Y → −z);
// film = (mill Y, mill Z, mill X) = (−z, y, x).
const toolpathAxes = new THREE.Group()
toolpathAxes.matrixAutoUpdate = false
toolpathAxes.matrix.set(0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1)
toolpathGroup.add(toolpathAxes)
toolpathGroup.scale.setScalar(S)

let toolpathLines: THREE.LineSegments | null = null
let toolpathColorAttr: THREE.BufferAttribute | null = null
const toolpathData = shallowRef<CompactToolpath | null>(null)

/** Which G-code to show: the one streaming, else the capture frame's. */
const toolpathTarget = computed(() => {
	const c = sequence.cutting
	const frame = c ? c.frame : project.captureShot.frame
	const layer = c ? c.layer : project.captureShot.layer
	const g = sequence.gcodeFor(frame, layer)
	if (!g) return null
	return {path: g.path, stamp: sequence.gcodeStamp(g), frame, layer}
})

let toolpathSeq = 0
watch(
	() => toolpathTarget.value && `${toolpathTarget.value.path}@${toolpathTarget.value.stamp}`,
	async () => {
		const seq = ++toolpathSeq
		const t = toolpathTarget.value
		const tp = t ? await sequence.toolpathFor(t.path, t.stamp) : null
		if (seq !== toolpathSeq) return
		toolpathData.value = tp
		setToolpath(tp)
	},
	{immediate: true}
)

function setToolpath(tp: CompactToolpath | null) {
	if (toolpathLines) {
		toolpathAxes.remove(toolpathLines)
		toolpathLines.geometry.dispose()
		;(toolpathLines.material as THREE.Material).dispose()
		toolpathLines = null
		toolpathColorAttr = null
	}
	if (!tp) return
	const geo = new THREE.BufferGeometry()
	geo.setAttribute('position', new THREE.BufferAttribute(tp.positions, 3))
	toolpathColorAttr = new THREE.BufferAttribute(new Float32Array(tp.rapid.length * 6), 3)
	toolpathColorAttr.setUsage(THREE.DynamicDrawUsage)
	geo.setAttribute('color', toolpathColorAttr)
	fillToolpathColors(tp, sentLines.value)
	toolpathLines = new THREE.LineSegments(
		geo,
		new THREE.LineBasicMaterial({vertexColors: true, transparent: true, opacity: 0.85})
	)
	toolpathLines.frustumCulled = false
	toolpathAxes.add(toolpathLines)
}

/** Lines already sent while this very file streams (−1 otherwise). */
const sentLines = computed(() => {
	const c = sequence.cutting
	const t = toolpathTarget.value
	if (!c || !t || c.path !== t.path) return -1
	return mill.streamProgress?.index ?? 0
})

function fillToolpathColors(tp: CompactToolpath, sent: number) {
	const attr = toolpathColorAttr
	if (!attr) return
	const col = attr.array as Float32Array
	const {cut, rapid, done} = TOOLPATH_COLORS
	for (let i = 0; i < tp.rapid.length; i++) {
		const c = tp.line[i] < sent ? done : tp.rapid[i] ? rapid : cut
		const o = i * 6
		col[o] = col[o + 3] = c.r
		col[o + 1] = col[o + 4] = c.g
		col[o + 2] = col[o + 5] = c.b
	}
	attr.needsUpdate = true
}

watch(sentLines, sent => {
	if (toolpathData.value) fillToolpathColors(toolpathData.value, sent)
})

// Where the file's origin (work zero) is in the mill's machine coordinates:
// the film origin when the cut points G54 there first (§7.1), otherwise the
// work offset the controller holds now — the one the G-code will run in.
const toolpathOriginMill = computed<vec3>(() => {
	if (project.addsub.cutSetsWorkOffset) {
		return filmOriginMill(filmLift.value, cal.value.filmOriginWorld, cal.value.millOffset)
	}
	const m = mill.mpos
	const w = mill.wpos
	const wco = (a: 'x' | 'y' | 'z') => (m[a] ?? 0) - (w[a] ?? m[a] ?? 0)
	return [wco('x'), wco('y'), wco('z')]
})

// The same in world, shifted with the table like the tool tip marker, so the
// marker sits on the path where the tool is in the program.
const toolpathOriginWorld = computed(() =>
	vec3.add(millToWorld(toolpathOriginMill.value, cal.value.millOffset), tableShift.value)
)

watch(
	toolpathOriginWorld,
	o => toolpathGroup.position.set(...vec3.scale(o, S)),
	{immediate: true}
)

/** Orbit the view onto the cut (its bounding sphere fills the view). */
function focusToolpath() {
	const tp = toolpathData.value
	if (!tp || !cameraCtrl || !camera) return
	// centre is in worker axes; map like the group does.
	const [x, y, z] = tp.centre
	const world = vec3.add(toolpathOriginWorld.value, [-z, y, x])
	const target = new THREE.Vector3(...vec3.scale(world, S))
	const dist = Math.max(0.05, tp.radius * S * 2.5)
	const dir = camera.position.clone().sub(cameraCtrl.target).normalize()
	if (dir.lengthSq() < 1e-6) dir.set(1, 0.8, 1).normalize()
	cameraCtrl.target.copy(target)
	camera.position.copy(target).addScaledVector(dir, dist)
	cameraCtrl.update()
	cameraControlPosition.value = camera.position.toArray()
	cameraControlTarget.value = cameraCtrl.target.toArray() as vec3
}

const shotPositions = computed(() => {
	const pts: THREE.Vector3[] = []
	project.komas.forEach(koma => {
		const shot = koma?.shots[0]
		if (!shot?.rig) return
		const lift = shot.filmLift ?? filmLift.value
		const pose = rigAxesToCameraPose(shot.rig, lift, cal.value)
		const w = filmToWorld(pose.position, lift, cal.value.filmOriginWorld)
		pts.push(new THREE.Vector3(...vec3.scale(w, S)))
	})
	return pts
})

watch(
	shotPositions,
	pts => {
		shotLine.geometry.setFromPoints(pts)
		shotLine.geometry.computeBoundingSphere()
	},
	{immediate: true}
)

const previzPositions = computed(() => {
	const pts: THREE.Vector3[] = []
	const from = project.captureShot.frame
	for (let f = from; f < from + 400; f++) {
		const pf = previz.frameFor(f)
		if (!pf?.pose) break
		const w = filmToWorld(pf.pose.position, filmLift.value, cal.value.filmOriginWorld)
		pts.push(new THREE.Vector3(...vec3.scale(w, S)))
	}
	return pts
})

watch(
	previzPositions,
	pts => {
		previzLine.geometry.setFromPoints(pts)
		previzLine.geometry.computeBoundingSphere()
	},
	{immediate: true}
)

function planWorldPoint(plan: FramePlan): THREE.Vector3 | null {
	const lift = filmLift.value
	let pose: {position: vec3} | null = null
	if (plan.rig) {
		// Axes the plan leaves out stay where the rig is now.
		pose = rigAxesToCameraPose({...rig.mpos, ...plan.rig}, lift, cal.value)
	} else if (plan.camera) {
		pose = plan.camera
	}
	if (!pose) return null
	const w = filmToWorld(pose.position, lift, cal.value.filmOriginWorld)
	return new THREE.Vector3(...vec3.scale(w, S))
}

const planPositions = computed(() => {
	const pts: THREE.Vector3[] = []
	const layer = project.captureShot.layer
	for (const f of plannedFrames(project, layer)) {
		const plan = planFor(project, f, layer)
		const p = plan && planWorldPoint(plan)
		if (p) pts.push(p)
	}
	return pts
})

const planInterpPositions = computed(() => {
	const pts: THREE.Vector3[] = []
	const layer = project.captureShot.layer
	for (const f of interpolatedFrames(project, layer)) {
		const eff = effectivePlanFor(project, f, layer)
		const p = eff && planWorldPoint(eff.plan)
		if (p) pts.push(p)
	}
	return pts
})

watch(
	planPositions,
	pts => {
		planLine.geometry.setFromPoints(pts)
		planLine.computeLineDistances()
		planLine.geometry.computeBoundingSphere()
		planPoints.geometry.setFromPoints(pts)
		planPoints.geometry.computeBoundingSphere()
	},
	{immediate: true}
)

watch(
	planInterpPositions,
	pts => {
		planInterpPoints.geometry.setFromPoints(pts)
		planInterpPoints.geometry.computeBoundingSphere()
	},
	{immediate: true}
)

// LED pixels: positions from the layout, colours from the store's wall
// buffer (what the wall shows, or would show — it is kept with or without
// the hardware connected).
watch(
	() => [led.layout, led.wallVersion] as const,
	([layout]) => {
		const n = layout.pixels.length
		const pos = new Float32Array(n * 3)
		const col = new Float32Array(n * 3)
		const wall = led.wall
		layout.pixels.forEach((px, i) => {
			pos[i * 3] = px.world[0] * S
			pos[i * 3 + 1] = px.world[1] * S
			pos[i * 3 + 2] = px.world[2] * S
			let r = 0.25
			let g = 0.25
			let b = 0.25
			const buf = wall[px.line]
			if (buf && px.index * 3 + 2 < buf.length) {
				r = 0.1 + (buf[px.index * 3] / 255) * 0.9
				g = 0.1 + (buf[px.index * 3 + 1] / 255) * 0.9
				b = 0.1 + (buf[px.index * 3 + 2] / 255) * 0.9
			}
			col[i * 3] = r
			col[i * 3 + 1] = g
			col[i * 3 + 2] = b
		})
		ledPoints.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
		ledPoints.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3))
		ledPoints.geometry.computeBoundingSphere()
	},
	{immediate: true}
)

//------------------------------------------------------------------------------
// Jog arrows

interface Arrow {
	machine: 'rig' | 'mill'
	axis: Axis
	sign: 1 | -1
	/** World direction the arrow points. */
	dir: vec3
	color: string
	/** Shown instead of ±axis (the camera-local arrows). */
	label?: string
}

// The camera's translation arrows, in one of two frames: `local` rides on the
// camera (right / up / along the view, so the blue pair dollies in and out),
// `global` is the rig's own X / Y / Z (= world axes).
type GizmoSpace = 'local' | 'global'
const gizmoSpace = Tq.config.ref<GizmoSpace>('addsub.view.gizmoSpace', 'local')

const RIG_AXES: {axis: 'x' | 'y' | 'z'; unit: vec3; color: string}[] = [
	{axis: 'x', unit: [1, 0, 0], color: '#ff5555'},
	{axis: 'y', unit: [0, 1, 0], color: '#55ff55'},
	{axis: 'z', unit: [0, 0, 1], color: '#5588ff'},
]

// The camera looks down its local −Z.
const LOCAL_LABELS: Record<string, string> = {
	'x1': 'Right',
	'x-1': 'Left',
	'y1': 'Up',
	'y-1': 'Down',
	'z1': 'Back',
	'z-1': 'Fwd',
}

const rigArrows = computed<Arrow[]>(() => {
	const local = gizmoSpace.value === 'local'
	const R = cameraPoseWorld.value.rotation
	return RIG_AXES.flatMap(({axis, unit, color}) =>
		([1, -1] as const).map(sign => {
			const dir = vec3.scale(unit, sign)
			return {
				machine: 'rig' as const,
				axis,
				sign,
				dir: local ? vec3.transformQuat(dir, R) : dir,
				color,
				label: local ? LOCAL_LABELS[`${axis}${sign}`] : undefined,
			}
		})
	)
})

// Mill: +X → world +Z, +Y → world +X, +Z → world +Y.
const millArrows: Arrow[] = [
	{machine: 'mill', axis: 'x', sign: 1, dir: [0, 0, 1], color: '#ff5555'},
	{machine: 'mill', axis: 'x', sign: -1, dir: [0, 0, -1], color: '#ff5555'},
	{machine: 'mill', axis: 'y', sign: 1, dir: [1, 0, 0], color: '#55ff55'},
	{machine: 'mill', axis: 'y', sign: -1, dir: [-1, 0, 0], color: '#55ff55'},
	{machine: 'mill', axis: 'z', sign: 1, dir: [0, 1, 0], color: '#5588ff'},
	{machine: 'mill', axis: 'z', sign: -1, dir: [0, -1, 0], color: '#5588ff'},
]

const ARROW_DIST = 0.18
const ARROW_LEN = 0.06
const RING_R = 0.26

function arrowTransform(origin: vec3, a: Arrow) {
	// Cone points +Y by default; rotate +Y onto dir.
	return arrowAt(vec3.add(origin, vec3.scale(a.dir, ARROW_DIST)), a.dir)
}

function arrowAt(position: vec3, dir: vec3) {
	const q = quat.rotationTo([0, 1, 0], vec3.normalize(dir))
	return matrixToThree(mat4.fromRotationTranslation(q, position))
}

/**
 * Rotation jogs for the head (§11.2): pairs of tangential cones on a ring
 * around the camera. Pan (B) turns about world Y; tilt (A) and roll (C) ride
 * on the camera's own X and Z, so their rings follow the camera rotation.
 * Which physical direction each sign is has to be confirmed on the machine.
 */
interface RotArrow {
	axis: Axis
	sign: 1 | -1
	position: vec3
	dir: vec3
	color: string
}

const rotArrows = computed<RotArrow[]>(() => {
	const c = vec3.scale(cameraPoseWorld.value.position, S)
	const R = cameraPoseWorld.value.rotation
	const local = (v: vec3) => vec3.transformQuat(v, R)
	const out: RotArrow[] = []
	// Pan about world Y: tangent at (±r,0,0) is ∓Z for +θ.
	out.push(
		{axis: 'b', sign: 1, position: vec3.add(c, [RING_R, 0, 0]), dir: [0, 0, -1], color: '#ff66ff'},
		{axis: 'b', sign: -1, position: vec3.add(c, [-RING_R, 0, 0]), dir: [0, 0, -1], color: '#ff66ff'}
	)
	// Tilt about camera X: tangent at (0,±r,0) is ±Z for +θ.
	out.push(
		{axis: 'a', sign: 1, position: vec3.add(c, local([0, RING_R, 0])), dir: local([0, 0, 1]), color: '#ffaa33'},
		{axis: 'a', sign: -1, position: vec3.add(c, local([0, -RING_R, 0])), dir: local([0, 0, 1]), color: '#ffaa33'}
	)
	// Roll about camera Z: tangent at (±r,0,0) is ±Y for +θ.
	out.push(
		{axis: 'c', sign: 1, position: vec3.add(c, local([RING_R * 0.8, RING_R * 0.6, 0])), dir: local([-0.6, 0.8, 0]), color: '#66ffff'},
		{axis: 'c', sign: -1, position: vec3.add(c, local([-RING_R * 0.8, RING_R * 0.6, 0])), dir: local([-0.6, -0.8, 0]), color: '#66ffff'}
	)
	return out
})

function rotArrowKey(a: RotArrow) {
	return `rot${a.axis}${a.sign}`
}

function onRotArrowClick(a: RotArrow) {
	if (!rig.connected || sequence.running) return
	rig.jogStepAxis(a.axis, a.sign).catch(() => {})
}

const hovered = ref<string | null>(null)

function arrowKey(a: Arrow) {
	return `${a.machine}${a.axis}${a.sign}`
}

function onArrowClick(a: Arrow) {
	const m = a.machine === 'rig' ? rig : mill
	if (!m.connected || sequence.running) return
	if (a.machine === 'rig' && gizmoSpace.value === 'local') {
		// One step along the arrow: the rig's X/Y/Z are world axes, so the
		// direction is the move itself.
		const delta: AxesPosition = {}
		;(['x', 'y', 'z'] as const).forEach((axis, i) => {
			const v = Math.round(a.dir[i] * rig.jogStep * 1000) / 1000
			if (v !== 0) delta[axis] = v
		})
		if (Object.keys(delta).length > 0) rig.jog(delta).catch(() => {})
		return
	}
	m.jogStepAxis(a.axis, a.sign).catch(() => {})
}

/**
 * Orbit handle: turns the camera about the vertical axis through world
 * X = Z = 0 (kinematics.ts `orbitRigAxes`) — X, Z and pan move together.
 * Drawn as a ring through the camera around that axis, with a cone either
 * side of the camera along it.
 */
const ORBIT_COLOR = '#ffd84d'
/** Distance of the cones from the camera along the ring (m). */
const ORBIT_ARC = 0.36

interface OrbitArrow {
	sign: 1 | -1
	position: vec3
	dir: vec3
}

const orbit = computed(() => {
	const p = vec3.scale(cameraPoseWorld.value.position, S)
	const radius = Math.hypot(p[0], p[2])
	// On the axis an orbit is just a pan.
	if (radius < 0.02) return null
	const phi = Math.min(60, (ORBIT_ARC / radius) * (180 / Math.PI))
	const arrows: OrbitArrow[] = ([1, -1] as const).map(sign => {
		const position = vec3.transformQuat(p, quat.fromAxisAngle([0, 1, 0], sign * phi))
		// Tangent for +θ about +Y at (x, ·, z) is (z, 0, −x).
		const dir = vec3.scale(vec3.normalize([position[2], 0, -position[0]]), sign)
		return {sign, position, dir}
	})
	return {centre: [0, p[1], 0] as vec3, radius, arrows}
})

function orbitArrowKey(a: OrbitArrow) {
	return `orbit${a.sign}`
}

// Why the last gizmo move was refused, shown for a moment in the rig block.
const notice = ref<string | null>(null)
let noticeTimer: ReturnType<typeof setTimeout> | undefined
function showNotice(text: string) {
	notice.value = text
	clearTimeout(noticeTimer)
	noticeTimer = setTimeout(() => (notice.value = null), 3000)
}

function onOrbitArrowClick(a: OrbitArrow) {
	if (!rig.connected || sequence.running) return
	const target = orbitRigAxes(rig.mpos, a.sign * rig.jogStep, cal.value)
	// The swing depends on where the rig really is, so stay inside its travel.
	const limits = project.addsub.rigLimits
	for (const axis of ['x', 'z'] as const) {
		const range = limits[axis]
		if (range && (target[axis] < range[0] || target[axis] > range[1])) {
			showNotice(
				`Orbit would take ${axis.toUpperCase()} to ${target[axis].toFixed(1)} (travel ${range[0]}…${range[1]})`
			)
			return
		}
	}
	const round = (v: number) => Math.round(v * 1000) / 1000
	rig
		.jog({
			x: round(target.x - (rig.mpos.x ?? 0)),
			z: round(target.z - (rig.mpos.z ?? 0)),
			b: round(target.b - (rig.mpos.b ?? 0)),
		})
		.catch(() => {})
}

const showArrows = computed(() => !viewport.isPlaying)

//------------------------------------------------------------------------------
// Gizmo decorations: text labels (billboard sprites) on every arrow and a ring
// per rotation axis, so the jog affordances read at a glance (§11.2).

function makeRing(centre: vec3, rotation: quat, radius: number, color: string, opacity = 0.55) {
	const pts: THREE.Vector3[] = []
	const N = 64
	for (let i = 0; i <= N; i++) {
		const t = (i / N) * Math.PI * 2
		// Ring in the local XY plane (normal = local Z), then rotated into place.
		const p = vec3.transformQuat([Math.cos(t) * radius, Math.sin(t) * radius, 0], rotation)
		pts.push(new THREE.Vector3(...vec3.add(centre, p)))
	}
	const geo = new THREE.BufferGeometry().setFromPoints(pts)
	return new THREE.Line(
		geo,
		new THREE.LineBasicMaterial({color, transparent: true, opacity})
	)
}

const AXIS_LABELS: Record<Axis, string> = {
	x: 'X',
	y: 'Y',
	z: 'Z',
	a: 'Tilt',
	b: 'Pan',
	c: 'Roll',
}

const decorations = new THREE.Group()

onMounted(() => {
	$lines.value?.add(decorations)
})

interface GizmoLabel {
	key: string
	text: string
	color: string
	/** Scene-unit position. */
	position: vec3
}

/**
 * Labels are HTML (same monospace font/size as the rest of the UI), projected
 * onto the canvas every frame, so they never scale with distance.
 */
const gizmoLabels = computed<GizmoLabel[]>(() => {
	if (!showArrows.value) return []
	const cam = vec3.scale(cameraPoseWorld.value.position, S)
	const tool = vec3.scale(toolTipWorld.value, S)
	const sign = (n: number) => (n > 0 ? '+' : '−')
	const out: GizmoLabel[] = []
	for (const a of rigArrows.value) {
		out.push({
			key: arrowKey(a),
			text: a.label ?? `${sign(a.sign)}${AXIS_LABELS[a.axis]}`,
			color: a.color,
			position: vec3.add(cam, vec3.scale(a.dir, ARROW_DIST + ARROW_LEN * 1.1)),
		})
	}
	for (const a of millArrows) {
		out.push({
			key: arrowKey(a),
			text: `${sign(a.sign)}${AXIS_LABELS[a.axis]}`,
			color: a.color,
			position: vec3.add(tool, vec3.scale(a.dir, ARROW_DIST + ARROW_LEN * 0.9)),
		})
	}
	for (const a of rotArrows.value) {
		const outward = vec3.normalize(vec3.sub(a.position, cam))
		out.push({
			key: rotArrowKey(a),
			text: `${sign(a.sign)}${AXIS_LABELS[a.axis]}`,
			color: a.color,
			position: vec3.add(a.position, vec3.scale(outward, 0.05)),
		})
	}
	for (const a of orbit.value?.arrows ?? []) {
		out.push({
			key: orbitArrowKey(a),
			text: `${sign(a.sign)}Orbit`,
			color: ORBIT_COLOR,
			position: vec3.add(a.position, vec3.scale(a.dir, ARROW_LEN * 1.1)),
		})
	}
	return out
})

const $labels = shallowRef<HTMLElement[]>([])
const projected = new THREE.Vector3()

/** Runs after every render: place each label over its projected point. */
// Own rAF loop (not troisjs's after-render hook, which some setups never
// fire). Elements are matched to labels by key: a v-for template ref array
// doesn't promise source order.
function placeLabels() {
	if (!camera || !$root.value) return
	const w = rootSize.width.value
	const h = rootSize.height.value
	const byKey = new Map(gizmoLabels.value.map(l => [l.key, l]))
	for (const el of $labels.value) {
		const l = byKey.get(el.dataset.key ?? '')
		if (!l) continue
		projected.set(...l.position).project(camera)
		const behind = projected.z > 1
		el.style.transform = `translate(${((projected.x + 1) / 2) * w}px, ${((1 - projected.y) / 2) * h}px) translate(-50%, -50%)`
		el.style.visibility = behind ? 'hidden' : 'visible'
	}
}

let labelRaf = 0
onMounted(() => {
	const loop = () => {
		placeLabels()
		labelRaf = requestAnimationFrame(loop)
	}
	labelRaf = requestAnimationFrame(loop)
})
onUnmounted(() => cancelAnimationFrame(labelRaf))

function rebuildDecorations() {
	decorations.clear()
	if (!showArrows.value) return

	const cam = vec3.scale(cameraPoseWorld.value.position, S)
	const R = cameraPoseWorld.value.rotation

	// Rotation rings: pan about world Y (ring in XZ), tilt about camera X (ring
	// in local YZ), roll about camera Z (ring in local XY).
	const ringX = quat.fromAxisAngle([0, 1, 0], 90) // local XY → YZ plane
	const ringY = quat.fromAxisAngle([1, 0, 0], 90) // local XY → XZ plane
	decorations.add(makeRing(cam, ringY, RING_R, '#ff66ff'))
	decorations.add(makeRing(cam, quat.mul(R, ringX), RING_R, '#ffaa33'))
	decorations.add(makeRing(cam, R, RING_R, '#66ffff'))

	// Orbit: the ring the camera rides round the vertical axis at X = Z = 0,
	// and that axis.
	const o = orbit.value
	if (o) {
		decorations.add(makeRing(o.centre, ringY, o.radius, ORBIT_COLOR, 0.3))
		decorations.add(
			new THREE.Line(
				new THREE.BufferGeometry().setFromPoints([
					new THREE.Vector3(0, 0, 0),
					new THREE.Vector3(0, o.centre[1] + 0.2, 0),
				]),
				new THREE.LineBasicMaterial({color: ORBIT_COLOR, transparent: true, opacity: 0.3})
			)
		)
	}
}

watch(
	() =>
		[cameraPoseWorld.value, toolTipWorld.value, showArrows.value, rotArrows.value, orbit.value] as const,
	rebuildDecorations,
	{immediate: true, deep: false}
)

//------------------------------------------------------------------------------
// Linearly → three

const euler = new THREE.Euler()
const q3 = new THREE.Quaternion()

function matrixToThree(m: mat4) {
	const q = mat4.getRotation(m)
	const t = mat4.getTranslation(m)
	const [x, y, z] = euler.setFromQuaternion(q3.fromArray([...q])).toArray()
	return {position: new THREE.Vector3(...t), rotation: {x, y, z}}
}

function v3(v: vec3, scale = S) {
	return new THREE.Vector3(...vec3.scale(v, scale))
}

const fmt = (v: number | undefined, d = 1) => (v === undefined ? '—' : v.toFixed(d))
</script>

<template>
	<div ref="$root" class="AddsubVisualizer">
		<div class="info tq-font-numeric">
			<div class="block">
				<div class="head">
					<span class="name">Box Rig</span>
					<span class="state" :class="{off: !rig.connected}">{{ rig.state ?? 'offline' }}</span>
				</div>
				<div class="axes">
					<span v-for="ax in ['x', 'y', 'z'] as const" :key="ax" class="axis">
						<span class="label">{{ ax.toUpperCase() }}</span>{{ fmt(rig.mpos[ax]) }}
					</span>
					<span v-for="ax in ['a', 'b', 'c'] as const" :key="ax" class="axis">
						<span class="label">{{ ax.toUpperCase() }}</span>{{ fmt(rig.mpos[ax], 2) }}°
					</span>
				</div>
				<div v-if="notice" class="notice">{{ notice }}</div>
			</div>
			<div class="block">
				<div class="head">
					<span class="name">Mill</span>
					<span class="state" :class="{off: !mill.connected}">{{ mill.state ?? 'offline' }}</span>
				</div>
				<div class="axes">
					<span v-for="ax in ['x', 'y', 'z'] as const" :key="ax" class="axis">
						<span class="label">{{ ax.toUpperCase() }}</span>{{ fmt(mill.mpos[ax]) }}
					</span>
				</div>
			</div>
			<div class="block">
				<div class="head">
					<span class="name">Sequence</span>
					<span class="state">lift {{ filmLift }} mm</span>
				</div>
				<div class="seq">{{ sequence.currentStep ?? (sequence.message ?? 'idle') }}</div>
			</div>
			<div v-if="toolpathTarget" class="block">
				<div class="head">
					<span class="name">Cut #{{ toolpathTarget.frame }}</span>
					<button class="focus" title="Look at the cut" @click="focusToolpath">focus</button>
				</div>
				<div v-if="toolpathData" class="seq">
					{{ toolpathData.lineCount }} lines
					<template v-if="sentLines >= 0"> · {{ sentLines }} sent</template>
				</div>
			</div>
		</div>
		<div v-if="showArrows" class="tools">
			<InputRadio
				v-model="gizmoSpace"
				v-tooltip="'Camera arrows: along the camera, or along the rig axes'"
				:options="['local', 'global']"
				:labels="['Local', 'Global']"
			/>
		</div>
		<div class="labels" aria-hidden="true">
			<span
				v-for="l in gizmoLabels"
				:key="l.key"
				ref="$labels"
				:data-key="l.key"
				class="gizmo-label tq-font-numeric"
				:style="{color: l.color}"
			>
				{{ l.text }}
			</span>
		</div>
		<Renderer
			resize="true"
			:alpha="true"
			:antialias="true"
			:orbitCtrl="true"
			:pointer="{intersectRecursive: false}"
			@ready="onRendererReady"
		>
			<Camera />
			<Scene :background="Tq.theme.colorBackground">
				<PointLight :color="Tq.theme.colorText" :position="{y: 3}" />
				<AmbientLight :color="Tq.theme.colorText" :intensity="0.5" />

				<!-- Camera on the rig -->
				<!-- camera.fbx has its lens along +Z; the camera looks down −Z (§10). -->
				<Group v-bind="cameraObject">
					<FbxModel
						src="./camera.fbx"
						:rotation="{y: Math.PI}"
						@load="onLoadCameraModel"
					/>
				</Group>

				<!-- Block stack + tool tip -->
				<Group :position="v3(blockOriginWorld)">
					<Box
						:width="blockHeight * S"
						:height="blockHeight * 2 * S"
						:depth="blockHeight * S"
						:position="{x: (blockHeight / 2) * S, y: blockHeight * S, z: (blockHeight / 2) * S}"
					>
						<BasicMaterial color="#c8a878" :props="{wireframe: true}" />
					</Box>
				</Group>
				<Sphere :radius="0.006" :position="v3(toolTipWorld)">
					<BasicMaterial color="#ffcc00" />
				</Sphere>

				<!-- Jog arrows -->
				<template v-if="showArrows">
					<Cone
						v-for="a in rigArrows"
						:key="arrowKey(a)"
						:radius="0.018"
						:height="ARROW_LEN"
						:radialSegments="12"
						v-bind="arrowTransform(vec3.scale(cameraPoseWorld.position, S), a)"
						@click="onArrowClick(a)"
						@pointerEnter="hovered = arrowKey(a)"
						@pointerLeave="hovered = null"
					>
						<BasicMaterial
							:color="a.color"
							:props="{transparent: true, opacity: hovered === arrowKey(a) ? 1 : 0.45}"
						/>
					</Cone>
					<Cone
						v-for="a in rotArrows"
						:key="rotArrowKey(a)"
						:radius="0.014"
						:height="ARROW_LEN * 0.8"
						:radialSegments="12"
						v-bind="arrowAt(a.position, a.dir)"
						@click="onRotArrowClick(a)"
						@pointerEnter="hovered = rotArrowKey(a)"
						@pointerLeave="hovered = null"
					>
						<BasicMaterial
							:color="a.color"
							:props="{transparent: true, opacity: hovered === rotArrowKey(a) ? 1 : 0.5}"
						/>
					</Cone>
					<Cone
						v-for="a in orbit?.arrows ?? []"
						:key="orbitArrowKey(a)"
						:radius="0.016"
						:height="ARROW_LEN * 0.9"
						:radialSegments="12"
						v-bind="arrowAt(a.position, a.dir)"
						@click="onOrbitArrowClick(a)"
						@pointerEnter="hovered = orbitArrowKey(a)"
						@pointerLeave="hovered = null"
					>
						<BasicMaterial
							:color="ORBIT_COLOR"
							:props="{transparent: true, opacity: hovered === orbitArrowKey(a) ? 1 : 0.5}"
						/>
					</Cone>
					<Cone
						v-for="a in millArrows"
						:key="arrowKey(a)"
						:radius="0.012"
						:height="ARROW_LEN * 0.7"
						:radialSegments="12"
						v-bind="arrowTransform(vec3.scale(toolTipWorld, S), a)"
						@click="onArrowClick(a)"
						@pointerEnter="hovered = arrowKey(a)"
						@pointerLeave="hovered = null"
					>
						<BasicMaterial
							:color="a.color"
							:props="{transparent: true, opacity: hovered === arrowKey(a) ? 1 : 0.45}"
						/>
					</Cone>
				</template>

				<Group ref="$guide" />
				<Group ref="$lines" />
			</Scene>
		</Renderer>
	</div>
</template>

<style lang="stylus" scoped>
.AddsubVisualizer
	position relative
	width 100%
	height 100%
	overflow hidden

.info
	position absolute
	top var(--tq-gap-control)
	left var(--tq-gap-control)
	display flex
	flex-direction column
	gap var(--tq-gap-group)
	pointer-events none
	z-index 1
	font-size 1em
	line-height 1.4

// Bottom corner: the top is taken by the info blocks in a narrow pane.
.tools
	position absolute
	bottom var(--tq-gap-control)
	right var(--tq-gap-control)
	z-index 2

.labels
	position absolute
	inset 0
	pointer-events none
	z-index 1
	overflow hidden

// Positioned each frame by placeLabels() via transform; must be a positioned
// block (transform is ignored on inline boxes, which stacks them top-left).
.gizmo-label
	position absolute
	top 0
	left 0
	white-space nowrap
	font-size 1em
	line-height 1
	padding 1px 3px
	border-radius 3px
	background unquote('color-mix(in srgb, var(--tq-color-background) 70%, transparent)')
	will-change transform

.block
	min-width 15em
	padding var(--tq-gap-group) var(--tq-gap-control)
	background unquote('color-mix(in srgb, var(--tq-color-background) 75%, transparent)')
	backdrop-filter blur(6px)
	border 1px solid unquote('var(--tq-color-border, rgba(128, 128, 128, 0.35))')
	border-radius var(--tq-radius-input)

.head
	display flex
	justify-content space-between
	align-items baseline
	gap 1em
	margin-bottom 0.15em

.name
	font-weight 700
	letter-spacing 0.03em

.state
	color var(--tq-color-accent)
	font-weight 600

	&.off
		color var(--tq-color-text-mute)

// The info panel ignores pointer events; the focus button opts back in.
.focus
	pointer-events auto
	font inherit
	font-size 0.85em
	color var(--tq-color-accent)
	background none
	border 1px solid currentColor
	border-radius var(--tq-radius-input)
	padding 0 0.5em
	cursor pointer

	&:hover
		background unquote('color-mix(in srgb, var(--tq-color-accent) 20%, transparent)')

.axes
	display grid
	grid-template-columns repeat(3, auto)
	gap 0.1em 1em
	font-variant-numeric tabular-nums

.axis
	white-space nowrap

.label
	display inline-block
	min-width 1.3em
	color var(--tq-color-text-mute)

.notice
	margin-top 0.2em
	max-width 22em
	color var(--tq-color-rec)

.seq
	white-space nowrap
	overflow hidden
	text-overflow ellipsis
	max-width 22em
</style>
