<script setup lang="ts">
import {mat3, Mat4, mat4, quat, Vec3, vec3} from 'linearly'
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
	const m = mat4.fromQuat(tracker.rotation)
	mat4.translate(m, tracker.position)
	return m
})

const position = computed(() => {
	return toThree(vec3.transformMat4(tracker.position, calibrationMatrix.value))
})

const euler = computed(() => {
	const calib = quat.fromMat3(mat3.fromMat4(calibrationMatrix.value))

	const q = new THREE.Quaternion(...quat.mul(calib, tracker.rotation))

	const euler = new THREE.Euler().setFromQuaternion(q)
	const [x, y, z] = euler.toArray().slice(0, 3) as any
	return {x, y, z}
})

const $trois = shallowRef<any>()

const $scene = shallowRef<any>()
const $guide = shallowRef<any>()

onMounted(() => {
	const guide: THREE.Group = $guide.value.group

	const cameraControl: OrbitControls = $trois.value.three.cameraCtrl

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
const origin = appConfig.ref<Vec3>('tracker.origin', vec3.zero)
const yAxis = appConfig.ref<Vec3>('tracker.yAxis', vec3.yAxis)
const xAxis = appConfig.ref<Vec3>('tracker.xAxis', vec3.xAxis)

const pan = appConfig.ref('tracker.pan', Math.PI)

setInterval(() => {
	pan.value += (Math.PI / 180) * 5
}, 100)

const calibrationMatrix = computed(() => {
	const zAxis = vec3.cross(xAxis.value, yAxis.value)

	const m = mat4.of(
		...xAxis.value,
		0,
		...yAxis.value,
		0,
		...zAxis,
		0,
		...origin.value,
		1
	)

	return mat4.invert(m) ?? mat4.identity
})

let originMatrix: Mat4 = mat4.identity

function setOrigin() {
	origin.value = tracker.position
	originMatrix = matrix.value
}
function setPan() {
	const p0 = vec3.transformMat4(vec3.xAxis, originMatrix)
	const p1 = vec3.transformMat4(vec3.xAxis, matrix.value)

	let up = vec3.normalize(vec3.cross(p0, p1))

	if (up[1] < 0) {
		up = vec3.negate(up)
	}

	yAxis.value = up
}

function setTilt() {
	const p0 = vec3.transformMat4(vec3.xAxis, originMatrix)
	const p1 = vec3.transformMat4(vec3.xAxis, matrix.value)

	const left = vec3.normalize(vec3.cross(p0, p1))

	xAxis.value = left
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
				<Sphere :radius="0.02" :position="toThree(yAxis)">
					<BasicMaterial color="#00ff00" />
				</Sphere>
				<Sphere :radius="0.02" :position="toThree(xAxis)">
					<BasicMaterial color="#ff0000" />
				</Sphere>
				<Group :rotation="euler" :position="position">
					<FbxModel src="./camera.fbx" />
				</Group>
				<Group ref="$guide" :position="{y: groundLevel}" />
			</Scene>
		</Renderer>
		<div class="info">
			<Tq.InputButton label="Set Origin" @click="setOrigin" />
			<Tq.InputButton label="Set Pan" @click="setPan" />
			<Tq.InputButton label="Set Tilt" @click="setTilt" />
			OSC Connected = {{ osc.connected }} <br />
			<br />
			Tracker Enabled = {{ tracker.enabled }} <br />
			Position = {{ tracker.position.map(v => v.toFixed(3)).join(', ') }}
			<br />
			Rotation = {{ tracker.rotation.map(v => v.toFixed(3)).join(', ') }}
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
