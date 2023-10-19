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
import {computed, onMounted, ref, shallowRef, toRaw} from 'vue'

import {useAuxStore} from '@/stores/aux'

import Axis from './Axis.vue'

const {tracker} = useAuxStore()
const appConfig = useAppConfigStore()
const theme = useThemeStore()
//------------------------------------------------------------------------------
// ThreeJS

const cameraControlPosition = appConfig.ref('cameraControl.position', [
	2, 2, 2,
] as const)

const $trois = shallowRef<any>()
const $guide = shallowRef<any>()

onMounted(() => {
	const cameraControl: OrbitControls = $trois.value.three.cameraCtrl
	const guide: THREE.Group = $guide.value.group

	cameraControl.object.position.set(...cameraControlPosition.value)

	cameraControl.addEventListener('end', () => {
		cameraControlPosition.value = cameraControl.object.position.toArray() as any
	})

	guide.add(new THREE.GridHelper(10, 10))
	guide.add(new THREE.AxesHelper(5))
})

//------------------------------------------------------------------------------
// Calibration

const matrix = computed(() => {
	return mat4.fromRotationTranslation(tracker.rotation, tracker.position)
})

const groundLevel = appConfig.ref('groundLevel', 0)

const origin = appConfig.ref<mat4>('tracker.origin', mat4.identity)

// Camera coordinate system relative to the tracker
const cameraAxisY = appConfig.ref<vec3>('tracker.yAxis', vec3.unitY)
const cameraAxisX = appConfig.ref<vec3>('tracker.xAxis', vec3.unitX)

const trackerToCameraMatrix = computed(() => {
	const y = toRaw(cameraAxisY.value)
	const z = vec3.normalize(vec3.cross(cameraAxisX.value, y))
	const x = vec3.normalize(vec3.cross(y, z))

	return mat4.fromAxesTranslation(x, y, z)
})

const calibratedMatrix = computed(() => {
	const McInv = mat4.invert(trackerToCameraMatrix.value) ?? mat4.ident
	const MoInv = mat4.invert(origin.value) ?? mat4.ident

	const inv = mat4.mul(McInv, MoInv)

	return mat4.mul(inv, matrix.value, trackerToCameraMatrix.value)
})

function setOrigin() {
	origin.value = matrix.value
}

const panOrigin = ref<mat4 | null>(null)
const tiltOrigin = ref<mat4 | null>(null)

function setPan() {
	if (!panOrigin.value) {
		panOrigin.value = mat4.invert(matrix.value) ?? mat4.ident
	} else {
		const delta = mat4.mul(matrix.value, panOrigin.value)
		const q = mat4.getRotation(delta)

		const up = quat.axisAngle(q).axis

		const matrixInv = [...(mat4.invert(matrix.value) ?? mat4.ident)] as any
		matrixInv[12] = matrixInv[13] = matrixInv[14] = 0

		cameraAxisY.value = vec3.transformMat4(up, matrixInv)
		panOrigin.value = null
	}
}

function setTilt() {
	if (!tiltOrigin.value) {
		tiltOrigin.value = mat4.invert(matrix.value) ?? mat4.ident
	} else {
		const delta = mat4.mul(matrix.value, tiltOrigin.value)
		const q = quat.invert(mat4.getRotation(delta))

		const left = quat.axisAngle(q).axis

		const matrixInv = [...(mat4.invert(matrix.value) ?? mat4.ident)] as any
		matrixInv[12] = matrixInv[13] = matrixInv[14] = 0

		cameraAxisX.value = vec3.transformMat4(left, matrixInv)
		tiltOrigin.value = null
	}
}

//------------------------------------------------------------------------------
// Linearly to ThreeJS conversions

function positionToThree(v: vec3) {
	return new THREE.Vector3(...v)
}

function matrixToThree(m: mat4) {
	const q = mat4.getRotation(m)
	const t = mat4.getTranslation(m)
	const quat = new THREE.Quaternion(...q)

	const euler = new THREE.Euler().setFromQuaternion(quat)
	const [x, y, z] = euler.toArray() as number[]
	return {
		position: positionToThree(t),
		rotation: {x, y, z},
	}
}

//------------------------------------------------------------------------------
const calibrationPanePosition = ref({
	anchor: 'right-top' as const,
	width: 'minimized' as const,
	height: 200 as number | 'minimized',
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
		>
			<Camera />
			<Scene ref="$scene" :background="theme.colorBackground">
				<PointLight :color="theme.colorOnBackground" :position="{y: 10}" />
				<AmbientLight :color="theme.colorOnBackground" :intensity="0.5" />
				<Group v-bind="matrixToThree(calibratedMatrix)">
					<FbxModel src="./camera.fbx" />
				</Group>
				<Group ref="$guide" :position="{y: groundLevel}" />

				<template v-if="!paneMinimized">
					<Axis :matrix="origin" />
					<Axis :matrix="matrix" />
					<Axis :matrix="trackerToCameraMatrix" />
					<Sphere :radius="0.02" :position="positionToThree(cameraAxisX)">
						<BasicMaterial color="#ff0000" />
					</Sphere>
					<Sphere :radius="0.02" :position="positionToThree(cameraAxisY)">
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
						<Tq.InputNumber v-model="groundLevel" :min="-2" :max="2" />
					</Tq.Parameter>
					<Tq.Parameter label="Origin" icon="carbon:center-circle">
						<Tq.InputButton label="Set" @click="setOrigin" />
					</Tq.Parameter>
					<Tq.Parameter label="Up" icon="mdi:axis-z-rotate-counterclockwise">
						<Tq.InputButton
							:label="panOrigin ? 'Set Pan-Left' : 'Set Pan-Right'"
							@click="setPan"
						/>
					</Tq.Parameter>
					<Tq.Parameter label="X Axis" icon="mdi:axis-x-arrow">
						<Tq.InputButton
							:label="tiltOrigin ? 'Set Tilt-Down' : 'Set Tilt-Up'"
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

.info
	position absolute
	top 0
</style>
