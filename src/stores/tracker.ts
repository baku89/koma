import {mat4, vec3} from 'linearly'
import {defineStore} from 'pinia'
import {useAppConfigStore} from 'tweeq'
import {computed, toRaw} from 'vue'

import {useAuxStore} from './aux'

export const useTrackerStore = defineStore('tracker', () => {
	const aux = useAuxStore()
	const appConfig = useAppConfigStore()

	const groundLevel = appConfig.ref('groundLevel', 0)

	const origin = appConfig.ref<mat4>('tracker.origin', mat4.identity)

	const cameraOffset = appConfig.ref<vec3>('tracker.offset', vec3.zero)

	// Camera coordinate system relative to the tracker
	const cameraAxisX = appConfig.ref<vec3>('tracker.xAxis', vec3.unitX)
	const cameraAxisY = appConfig.ref<vec3>('tracker.yAxis', vec3.unitY)

	const trackerToCameraMatrix = computed(() => {
		const y = toRaw(cameraAxisY.value)
		const z = vec3.normalize(vec3.cross(cameraAxisX.value, y))
		const x = vec3.normalize(vec3.cross(y, z))

		return mat4.mul(
			mat4.fromAxesTranslation(x, y, z),
			mat4.fromTranslation(cameraOffset.value)
		)
	})

	const rawMatrix = computed(() => {
		return mat4.fromRotationTranslation(
			aux.tracker.rotation,
			aux.tracker.position
		)
	})

	const calibrationMatrix = computed(() => {
		const McInv = mat4.invert(trackerToCameraMatrix.value) ?? mat4.ident
		const MoInv = mat4.invert(origin.value) ?? mat4.ident

		return mat4.mul(McInv, MoInv)
	})

	const matrix = computed(() => {
		return mat4.mul(
			calibrationMatrix.value,
			rawMatrix.value,
			trackerToCameraMatrix.value
		)
	})

	const position = computed(() => {
		return mat4.getTranslation(matrix.value)
	})

	const rotation = computed(() => {
		return mat4.getRotation(matrix.value)
	})

	return {
		matrix,
		position,
		rotation,
		groundLevel,

		// Tracker information
		enabled: computed(() => aux.tracker.enabled),
		rawMatrix,

		// Calibration information
		origin,
		cameraOffset,
		trackerToCameraMatrix,
		cameraAxisX,
		cameraAxisY,
	}
})
