<script setup lang="ts">
import {Mat4, mat4, Vec3, vec3} from 'linearly'
import * as THREE from 'three'
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js'
import {
	AmbientLight,
	BasicMaterial,
	Camera,
	FbxModel,
	Group,
	PointLight,
	Renderer,
	Scene,
	Sphere,
} from 'troisjs'
import {useAppConfigStore, useTheme} from 'tweeq'
import Tq from 'tweeq'
import {computed, onMounted, shallowRef} from 'vue'

import {useAuxStore} from '@/stores/aux'
import {useOscStore} from '@/stores/osc'

import Axis from './Axis.vue'

const {tracker} = useAuxStore()
const osc = useOscStore()
const appConfig = useAppConfigStore()
const theme = useTheme()

const cameraControlPosition = appConfig.ref('cameraControl.position', [
	2, 2, 2,
] as const)

//------------------------------------------------------------------------------
// Tracker

const matrix = computed(() => {
	return mat4.mul(
		mat4.fromTranslation(tracker.position),
		mat4.fromQuat(tracker.rotation)
	)
})

const position = computed(() => {
	return toThree(tracker.position)
})

const euler = computed(() => {
	const q = new THREE.Quaternion(...tracker.rotation)
	const euler = new THREE.Euler().setFromQuaternion(q)
	const [x, y, z] = euler.toArray().slice(0, 3) as any
	return {x, y, z}
})

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

const groundLevel = appConfig.ref('groundLevel', 0)
const origin = appConfig.ref<Mat4>('tracker.origin', mat4.ident)

// Camera coordinate system relative to the tracker
const cameraAxisY = appConfig.ref<Vec3>('tracker.yAxis', vec3.unitY)
const cameraAxisX = appConfig.ref<Vec3>('tracker.xAxis', vec3.unitX)

function setOrigin() {
	origin.value = matrix.value
}
function setPan() {
	const p0 = vec3.transformQuat(vec3.unitX, mat4.getRotation(origin.value))
	const p1 = vec3.transformQuat(vec3.unitX, mat4.getRotation(matrix.value))

	const up = vec3.normalize(vec3.cross(p0, p1))

	const originInv = mat4.clone(mat4.invert(origin.value) ?? mat4.identity)

	originInv[12] = 0
	originInv[13] = 0
	originInv[14] = 0

	cameraAxisY.value = vec3.transformMat4(up, originInv)
}

function setTilt() {
	const p0 = vec3.transformQuat(
		cameraAxisY.value,
		mat4.getRotation(origin.value)
	)
	const p1 = vec3.transformQuat(
		cameraAxisY.value,
		mat4.getRotation(matrix.value)
	)

	const left = vec3.normalize(vec3.cross(p0, p1))

	cameraAxisX.value = left
}

function toThree(v: Vec3) {
	return new THREE.Vector3(...v)
}
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
				<Sphere :radius="0.02" :position="toThree(cameraAxisY)">
					<BasicMaterial color="#00ff00" />
				</Sphere>
				<Axis :matrix="origin" />
				<Axis :matrix="matrix" />
				<Sphere :radius="0.02" :position="toThree(cameraAxisX)">
					<BasicMaterial color="#ff0000" />
				</Sphere>
				<Group :rotation="euler" :position="position">
					<FbxModel src="./camera.fbx" />
				</Group>
				<Group ref="$guide" :position="{y: groundLevel}" />
			</Scene>
		</Renderer>
		<div class="info tq-font-numeric">
			<Tq.InputButton label="Set Origin" @click="setOrigin" />
			<Tq.InputButton label="Set Pan" @click="setPan" />
			<Tq.InputButton label="Set Tilt" @click="setTilt" />
			OSC Connected = {{ osc.connected }} <br />
			Tracker Enabled = {{ tracker.enabled }} <br />
		</div>
	</div>
</template>

<style lang="stylus" scoped>

.CameraTrajectoryVisualizer
	position relative
	width 100%
	height 100%
	background blue

.info
	position absolute
	top 0
</style>
