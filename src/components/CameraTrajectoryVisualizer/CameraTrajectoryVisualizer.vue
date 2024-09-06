<script setup lang="ts">
import {useElementSize} from '@vueuse/core'
import {mat4, quat, vec3} from 'linearly'
import * as THREE from 'three'
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js'
import {
	AmbientLight,
	Camera,
	FbxModel,
	Group,
	PointLight,
	Renderer,
	Scene,
} from 'troisjs'
import {useTweeq} from 'tweeq'
import {ref, shallowRef, watch} from 'vue'

import {useTrackerStore} from '@/stores/tracker'

import Axis from './Axis.vue'
import CameraTrajectory from './CameraTrajectory.vue'
import TrackerRecButton from './TrackerRecButton.vue'

const Tq = useTweeq()
const tracker = useTrackerStore()

//------------------------------------------------------------------------------
// ThreeJS
const cameraControlPosition = Tq.config.ref('cameraControl.position', [
	2, 2, 2,
] as vec3)

let renderer: THREE.WebGLRenderer
let camera: THREE.PerspectiveCamera

const $root = shallowRef<HTMLElement | null>(null)
const $guide = shallowRef<any>()

const rootSize = useElementSize($root)

watch(
	() => [rootSize.width.value, rootSize.height.value],
	([w, h]) => {
		if (!renderer || !camera) return

		renderer.setSize(w, h)
		camera.aspect = w / h
		camera.updateProjectionMatrix()
	}
)

function onLoadCameraModel(group: THREE.Group) {
	const mesh = group.children[0] as THREE.Mesh
	const material = mesh.material as THREE.MeshPhongMaterial
	material.opacity = 0.5
	material.transparent = true
}

function onRendererReady(trois: any) {
	const cameraControl: OrbitControls = trois.three.cameraCtrl
	const guide: THREE.Group = $guide.value.group

	renderer = trois.three.renderer
	camera = cameraControl.object as THREE.PerspectiveCamera

	camera.position.set(...cameraControlPosition.value)

	cameraControl.enablePan = false
	cameraControl.addEventListener('end', () => {
		cameraControlPosition.value = camera.position.toArray()
	})

	guide.add(new THREE.GridHelper(10, 10))
	guide.add(new THREE.AxesHelper(5))

	watch(
		() => tracker.position,
		(curt, prev) => {
			const delta = new THREE.Vector3(...vec3.sub(curt, prev ?? curt))
			cameraControl.target = new THREE.Vector3(...curt)
			camera.position.add(delta)
		},
		{immediate: true}
	)
}

//------------------------------------------------------------------------------
// Calibration

const moveOrigin = ref<mat4 | null>(null)

function setMove(rawMatrix: mat4) {
	const matrix = tracker.compensateRawMatrix(rawMatrix)

	if (!moveOrigin.value) {
		moveOrigin.value = matrix
	} else {
		tracker.calibrateOriginMatrix(matrix, moveOrigin.value)
		moveOrigin.value = null
	}
}

const yOrigin = ref<mat4 | null>(null)

function setUp(rawMatrix: mat4) {
	const matrix = tracker.compensateRawMatrix(rawMatrix)
	if (!yOrigin.value) {
		yOrigin.value = matrix
	} else {
		const originPos = mat4.getTranslation(yOrigin.value)
		const offsetPos = mat4.getTranslation(matrix)

		const oldXAxis: vec3 = [
			yOrigin.value[0],
			yOrigin.value[1],
			yOrigin.value[2],
		]

		const yAxis = vec3.normalize(vec3.sub(offsetPos, originPos))
		const zAxis = vec3.normalize(vec3.cross(oldXAxis, yAxis))
		const xAxis = vec3.cross(yAxis, zAxis)

		const targetMatrix: mat4 = mat4.fromAxesTranslation(
			xAxis,
			yAxis,
			zAxis,
			originPos
		)

		tracker.calibrateOriginMatrix(yOrigin.value, targetMatrix)

		yOrigin.value = null
	}
}

/**
 * First and second points represents +Z axis, and the third point is to determine +Y axis
 */
const horizonSamples = ref<vec3[]>([])

function addHorizonSample(rawMatrix: mat4) {
	const matrix = tracker.compensateRawMatrix(rawMatrix)
	const t = mat4.getTranslation(matrix)

	horizonSamples.value = [...horizonSamples.value, t]

	if (horizonSamples.value.length === 3) {
		const [p0, p1, p2] = horizonSamples.value

		// Detemrine the new Z axis at first
		const zAxis = vec3.normalize(vec3.sub(p1, p0))

		// Determine the new Y axis
		let yAxis = vec3.normalize(vec3.cross(zAxis, vec3.sub(p2, p0)))

		if (yAxis[1] < 0) {
			yAxis = vec3.negate(yAxis)
		}

		// Then, determine the new X axis so that the new matrix is orthogonal
		const xAxis = vec3.cross(yAxis, zAxis)

		tracker.calibrateOriginMatrix(
			mat4.fromAxesTranslation(xAxis, yAxis, zAxis),
			mat4.ident
		)

		horizonSamples.value = []
	}
}

const panOrigin = ref<mat4 | null>(null)

function setPan(rawMatrix: mat4) {
	if (!panOrigin.value) {
		panOrigin.value = mat4.invert(rawMatrix) ?? mat4.ident
	} else {
		const delta = mat4.mul(rawMatrix, panOrigin.value)
		const q = mat4.getRotation(delta)

		const up = quat.axisAngle(q).axis

		const matrixInv = mat4.clone(mat4.invert(rawMatrix) ?? mat4.ident)
		matrixInv[12] = matrixInv[13] = matrixInv[14] = 0

		tracker.cameraAxisY = vec3.transformMat4(up, matrixInv)
		panOrigin.value = null
	}
}

const tiltOrigin = ref<mat4 | null>(null)

function setTilt(rawMatrix: mat4) {
	if (!tiltOrigin.value) {
		tiltOrigin.value = mat4.invert(rawMatrix) ?? mat4.ident
	} else {
		const delta = mat4.mul(rawMatrix, tiltOrigin.value)
		const q = quat.invert(mat4.getRotation(delta))

		const left = quat.axisAngle(q).axis

		const matrixInv = mat4.clone(mat4.invert(rawMatrix) ?? mat4.ident)
		matrixInv[12] = matrixInv[13] = matrixInv[14] = 0

		tracker.cameraAxisX = vec3.transformMat4(left, matrixInv)
		tiltOrigin.value = null
	}
}

//------------------------------------------------------------------------------
// Linearly to ThreeJS conversions

function positionToThree(v: vec3) {
	return new THREE.Vector3(...v)
}

const _euler = new THREE.Euler()
const _quat = new THREE.Quaternion()

function matrixToThree(m: mat4) {
	const q = mat4.getRotation(m)
	const t = mat4.getTranslation(m)

	const [x, y, z] = _euler
		.setFromQuaternion(_quat.fromArray(q))
		.toArray() as number[]

	return {
		position: positionToThree(t),
		rotation: {x, y, z},
	}
}

//------------------------------------------------------------------------------
// Pane
const paneExpanded = ref(false)
</script>

<template>
	<div ref="$root" class="CameraTrajectoryVisualizer">
		<div class="info tq-font-numeric">
			X = {{ tracker.position[0].toFixed(3) }} <br />
			Y = {{ tracker.position[1].toFixed(3) }} <br />
			Z = {{ tracker.position[2].toFixed(3) }} <br />
		</div>
		<Renderer
			ref="$trois"
			resize="true"
			:alpha="true"
			:antialias="true"
			:orbitCtrl="true"
			@ready="onRendererReady"
		>
			<Camera />
			<Scene ref="$scene" :background="Tq.theme.colorBackground">
				<PointLight :color="Tq.theme.colorOnBackground" :position="{y: 10}" />
				<AmbientLight :color="Tq.theme.colorOnBackground" :intensity="0.5" />
				<Group v-bind="matrixToThree(tracker.matrix)">
					<FbxModel src="./camera.fbx" @load="onLoadCameraModel" />
				</Group>
				<Group ref="$guide" :position="{y: tracker.groundLevel}" />
				<CameraTrajectory />

				<template v-if="paneExpanded">
					<Axis :matrix="tracker.rawMatrix" />
					<Axis :matrix="tracker.trackerToCameraMatrix" />
					<Sphere
						:radius="0.02"
						:position="positionToThree(tracker.cameraAxisX)"
					>
						<BasicMaterial color="#ff0000" />
					</Sphere>
					<Sphere
						:radius="0.02"
						:position="positionToThree(tracker.cameraAxisY)"
					>
						<BasicMaterial color="#00ff00" />
					</Sphere>
				</template>
			</Scene>
		</Renderer>
		<Tq.PaneExpandable
			icon="mdi:gear"
			@expand="paneExpanded = true"
			@collapse="paneExpanded = false"
		>
			<Tq.ParameterGrid>
				<Tq.ParameterHeading>Calibration</Tq.ParameterHeading>
				<Tq.Parameter label="Ground" icon="tabler:circuit-ground">
					<Tq.InputNumber v-model="tracker.groundLevel" :min="-2" :max="2" />
				</Tq.Parameter>
				<Tq.Parameter label="Origin" icon="carbon:center-circle">
					<TrackerRecButton
						label="Set"
						@record="tracker.originMatrix = $event"
					/>
				</Tq.Parameter>
				<Tq.Parameter label="Move Receiver" icon="material-symbols:move">
					<TrackerRecButton
						:label="!moveOrigin ? 'Record Matrix' : 'Delta Matrix'"
						:blink="!!moveOrigin"
						@record="setMove"
					/>
				</Tq.Parameter>
				<Tq.Parameter label="Set Up" icon="material-symbols:move">
					<TrackerRecButton
						:label="!yOrigin ? 'Set Slider-Down' : 'Set Slider-Up'"
						:blink="!!yOrigin"
						@record="setUp"
					/>
				</Tq.Parameter>
				<Tq.Parameter label="Horizon" icon="ph:road-horizon">
					<TrackerRecButton
						:label="
							horizonSamples.length === 0
								? 'Record First Point'
								: horizonSamples.length === 1
									? 'Record +Z Point'
									: 'Record alternative Point'
						"
						:blink="horizonSamples.length > 0"
						@record="addHorizonSample"
					/>
				</Tq.Parameter>
				<Tq.Parameter label="Offset" icon="mdi:axis-arrow">
					<Tq.InputVec v-model="tracker.cameraOffset" />
				</Tq.Parameter>
				<Tq.Parameter label="Y Axis" icon="mdi:axis-z-rotate-counterclockwise">
					<Tq.InputVec v-model="tracker.cameraAxisY" :min="-1" :max="1" />
					<TrackerRecButton
						:label="panOrigin ? 'Set Pan-Left' : 'Set Pan-Right'"
						:blink="!!panOrigin"
						@record="setPan"
					/>
				</Tq.Parameter>
				<Tq.Parameter label="X Axis" icon="mdi:axis-x-arrow">
					<Tq.InputVec v-model="tracker.cameraAxisX" :min="-1" :max="1" />
					<TrackerRecButton
						:label="tiltOrigin ? 'Set Tilt-Up' : 'Set Tilt-Down'"
						:blink="!!tiltOrigin"
						@record="setTilt"
					/>
				</Tq.Parameter>
			</Tq.ParameterGrid>
		</Tq.PaneExpandable>
	</div>
</template>

<style lang="stylus" scoped>
.CameraTrajectoryVisualizer
	position relative
	width 100%
	height 100%
	overflow hidden

.info
	position absolute
	top 0
</style>
