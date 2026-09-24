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
import {useTweeq} from 'tweeq'
import {computed, onMounted, ref, shallowRef, watch} from 'vue'

import {useProjectStore} from '@/stores/project'
import {useViewportStore} from '@/stores/viewport'
import type {Axis} from '@/utils/fluidnc'

import {BLOCK_HEIGHT} from '../config'
import {filmToWorld, millToWorld, tableShiftWorld} from '../coords'
import {rigAxesToCameraPose} from '../kinematics'
import {ledBottomY} from '../led/layout'
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
const kBase = computed(() => project.addsub.kBase)

//------------------------------------------------------------------------------
// Poses

/** Current camera pose (world) from the rig's reported axes. */
const cameraPoseWorld = computed(() => {
	const pose = rigAxesToCameraPose(rig.mpos, kBase.value, cal.value)
	return {
		position: filmToWorld(pose.position, kBase.value, cal.value.filmOriginWorld),
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

// Nominal block footprint for display (mm). Blocks are 60 mm tall; the
// footprint isn't specified, so draw a cube.
const BLOCK_W = BLOCK_HEIGHT

//------------------------------------------------------------------------------
// LED wall outline

const wall = computed(() => {
	const p = project.addsub.led.layout
	const top = p.topY * S
	const bottom = ledBottomY(p) * S
	const h = (p.faceWidth / 2) * S
	return {top, bottom, h}
})

//------------------------------------------------------------------------------
// Renderer plumbing

const cameraControlPosition = Tq.config.ref('addsub.view.position', vec3.of(3, 2.5, 3))
const cameraControlTarget = Tq.config.ref('addsub.view.target', vec3.of(0, 0.8, 0))

let renderer: THREE.WebGLRenderer
let camera: THREE.PerspectiveCamera

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
	const {top, bottom, h} = wall.value
	const pts: THREE.Vector3[] = []
	for (const y of [top, bottom]) {
		const ring = [
			[-h, y, h],
			[-h, y, -h],
			[h, y, -h],
			[h, y, h],
			[-h, y, h],
		]
		for (let i = 0; i < ring.length - 1; i++) {
			pts.push(new THREE.Vector3(...ring[i]), new THREE.Vector3(...ring[i + 1]))
		}
	}
	for (const [x, z] of [
		[-h, h],
		[-h, -h],
		[h, -h],
		[h, h],
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
const ledPoints = new THREE.Points(
	new THREE.BufferGeometry(),
	new THREE.PointsMaterial({size: 0.012, vertexColors: true})
)

onMounted(() => {
	const g = $lines.value
	if (!g) return
	g.add(shotLine)
	g.add(previzLine)
	g.add(ledPoints)
})

const shotPositions = computed(() => {
	const pts: THREE.Vector3[] = []
	project.komas.forEach(koma => {
		const shot = koma?.shots[0]
		if (!shot?.rig) return
		const k = shot.kBase ?? kBase.value
		const pose = rigAxesToCameraPose(shot.rig, k, cal.value)
		const w = filmToWorld(pose.position, k, cal.value.filmOriginWorld)
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
		const w = filmToWorld(pf.pose.position, kBase.value, cal.value.filmOriginWorld)
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

// LED pixels: positions from the layout, colours from the device buffer when
// connected (dim grey otherwise).
watch(
	() => [led.layout, led.lastShow, led.connected] as const,
	([layout]) => {
		const n = layout.pixels.length
		const pos = new Float32Array(n * 3)
		const col = new Float32Array(n * 3)
		const dev = led.device
		layout.pixels.forEach((px, i) => {
			pos[i * 3] = px.world[0] * S
			pos[i * 3 + 1] = px.world[1] * S
			pos[i * 3 + 2] = px.world[2] * S
			let r = 0.25
			let g = 0.25
			let b = 0.25
			if (dev && px.line < dev.lineCount) {
				const buf = dev.getLine(px.line)
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
}

// Rig axes are world axes. Mill: +X → world +Z, +Y → world +X, +Z → world +Y.
const rigArrows: Arrow[] = [
	{machine: 'rig', axis: 'x', sign: 1, dir: [1, 0, 0], color: '#ff5555'},
	{machine: 'rig', axis: 'x', sign: -1, dir: [-1, 0, 0], color: '#ff5555'},
	{machine: 'rig', axis: 'y', sign: 1, dir: [0, 1, 0], color: '#55ff55'},
	{machine: 'rig', axis: 'y', sign: -1, dir: [0, -1, 0], color: '#55ff55'},
	{machine: 'rig', axis: 'z', sign: 1, dir: [0, 0, 1], color: '#5588ff'},
	{machine: 'rig', axis: 'z', sign: -1, dir: [0, 0, -1], color: '#5588ff'},
]
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
	m.jogStepAxis(a.axis, a.sign).catch(() => {})
}

const showArrows = computed(() => !viewport.isPlaying)

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
					<span class="state">k_base {{ kBase }}</span>
				</div>
				<div class="seq">{{ sequence.currentStep ?? (sequence.message ?? 'idle') }}</div>
			</div>
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
				<Group v-bind="cameraObject">
					<FbxModel src="./camera.fbx" @load="onLoadCameraModel" />
				</Group>

				<!-- Block stack + tool tip -->
				<Group :position="v3(blockOriginWorld)">
					<Box
						:width="BLOCK_W * S"
						:height="BLOCK_HEIGHT * 2 * S"
						:depth="BLOCK_W * S"
						:position="{x: (BLOCK_W / 2) * S, y: BLOCK_HEIGHT * S, z: (BLOCK_W / 2) * S}"
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

.seq
	white-space nowrap
	overflow hidden
	text-overflow ellipsis
	max-width 22em
</style>
