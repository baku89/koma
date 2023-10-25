<script setup lang="ts">
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
import {useAppConfigStore, useThemeStore} from 'tweeq'
import Tq from 'tweeq'
import {computed, ref, shallowRef, watch} from 'vue'

import {useTrackerStore} from '@/stores/tracker'

import Axis from './Axis.vue'
import CameraTrajectory from './CameraTrajectory.vue'

const appConfig = useAppConfigStore()
const theme = useThemeStore()
const tracker = useTrackerStore()

//------------------------------------------------------------------------------
// ThreeJS

const cameraControlPosition = appConfig.ref('cameraControl.position', [
	2, 2, 2,
] as const)

const $guide = shallowRef<any>()

function onLoadCameraModel(group: THREE.Group) {
	const mesh = group.children[0] as THREE.Mesh
	const material = mesh.material as THREE.MeshPhongMaterial
	material.opacity = 0.7
	material.transparent = true
}

function onRendererReady(trois: any) {
	const cameraControl: OrbitControls = trois.three.cameraCtrl
	const guide: THREE.Group = $guide.value.group

	const camera = cameraControl.object as THREE.PerspectiveCamera

	camera.position.set(...cameraControlPosition.value)
	camera.near = 0.001
	camera.far = 100
	camera.updateProjectionMatrix()

	cameraControl.enablePan = false
	cameraControl.addEventListener('end', () => {
		cameraControlPosition.value = camera.position.toArray() as any
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

const panOrigin = ref<mat4 | null>(null)
const tiltOrigin = ref<mat4 | null>(null)

function setOrigin() {
	tracker.origin = tracker.rawMatrix
}

function setPan() {
	if (!panOrigin.value) {
		panOrigin.value = mat4.invert(tracker.rawMatrix) ?? mat4.ident
	} else {
		const delta = mat4.mul(tracker.rawMatrix, panOrigin.value)
		const q = mat4.getRotation(delta)

		const up = quat.axisAngle(q).axis

		const matrixInv = [...(mat4.invert(tracker.rawMatrix) ?? mat4.ident)] as any
		matrixInv[12] = matrixInv[13] = matrixInv[14] = 0

		tracker.cameraAxisY = vec3.transformMat4(up, matrixInv)
		panOrigin.value = null
	}
}

function setTilt() {
	if (!tiltOrigin.value) {
		tiltOrigin.value = mat4.invert(tracker.rawMatrix) ?? mat4.ident
	} else {
		const delta = mat4.mul(tracker.rawMatrix, tiltOrigin.value)
		const q = quat.invert(mat4.getRotation(delta))

		const left = quat.axisAngle(q).axis

		const matrixInv = [...(mat4.invert(tracker.rawMatrix) ?? mat4.ident)] as any
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

const calibrationPanePosition = ref({
	anchor: 'right-top' as const,
	width: 'minimized' as const,
	height: 400 as number | 'minimized',
})

const paneMinimized = computed(
	() =>
		calibrationPanePosition.value.width === 'minimized' ||
		calibrationPanePosition.value.height === 'minimized'
)
</script>

<template>
	<div class="CameraTrajectoryVisualizer">
		<Renderer
			ref="$trois"
			resize="true"
			:alpha="true"
			:antialias="true"
			:orbitCtrl="true"
			@ready="onRendererReady"
		>
			<Camera />
			<Scene ref="$scene" :background="theme.colorBackground">
				<PointLight :color="theme.colorOnBackground" :position="{y: 10}" />
				<AmbientLight :color="theme.colorOnBackground" :intensity="0.5" />
				<Group v-bind="matrixToThree(tracker.matrix)">
					<FbxModel src="./camera.fbx" @load="onLoadCameraModel" />
				</Group>
				<Group ref="$guide" :position="{y: tracker.groundLevel}" />
				<CameraTrajectory />

				<template v-if="!paneMinimized">
					<Axis :matrix="tracker.origin" />
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
		<div class="info tq-font-numeric">
			<Tq.PaneFloating
				v-model:position="calibrationPanePosition"
				name="camera.calibration"
				icon="mdi:gear"
			>
				<Tq.ParameterGrid>
					<Tq.ParameterHeading>Calibration</Tq.ParameterHeading>
					<Tq.Parameter label="Ground" icon="tabler:circuit-ground">
						<Tq.InputNumber v-model="tracker.groundLevel" :min="-2" :max="2" />
					</Tq.Parameter>
					<Tq.Parameter label="Origin" icon="carbon:center-circle">
						<Tq.InputButton label="Set" @click="setOrigin" />
					</Tq.Parameter>
					<Tq.Parameter label="Offset" icon="mdi:axis-arrow">
						<Tq.InputVec v-model="tracker.cameraOffset" />
					</Tq.Parameter>
					<Tq.Parameter label="Up" icon="mdi:axis-z-rotate-counterclockwise">
						<Tq.InputVec v-model="tracker.cameraAxisY" :min="-1" :max="1" />
						<Tq.InputButton
							:label="panOrigin ? 'Set Pan-Left' : 'Set Pan-Right'"
							:blink="!!panOrigin"
							@click="setPan"
						/>
					</Tq.Parameter>
					<Tq.Parameter label="X Axis" icon="mdi:axis-x-arrow">
						<Tq.InputVec v-model="tracker.cameraAxisX" :min="-1" :max="1" />
						<Tq.InputButton
							:label="tiltOrigin ? 'Set Tilt-Up' : 'Set Tilt-Down'"
							:blink="!!tiltOrigin"
							@click="setTilt"
						/>
					</Tq.Parameter>
				</Tq.ParameterGrid>
			</Tq.PaneFloating>
		</div>
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
