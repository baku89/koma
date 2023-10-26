import {mat4, quat, vec3, vec4} from 'linearly'
import {defineStore} from 'pinia'
import {useAppConfigStore} from 'tweeq'
import {computed} from 'vue'

import {useAuxStore} from './aux'
import {useProjectStore} from './project'

export const useTrackerStore = defineStore('tracker', () => {
	const aux = useAuxStore()
	const project = useProjectStore()
	const appConfig = useAppConfigStore()

	const groundLevel = appConfig.ref('tracker.groundLevel', 0)

	const calibrationMatrix = appConfig.ref<mat4>(
		'tracker.calibrationMatrix',
		mat4.identity
	)

	function setOrigin(matrix: mat4) {
		const McInv = mat4.invert(trackerToCameraMatrix.value) ?? mat4.ident
		const MoInv = mat4.invert(matrix) ?? mat4.ident

		calibrationMatrix.value = mat4.mul(McInv, MoInv)
	}

	const cameraOffset = appConfig.ref<vec3>('tracker.offset', vec3.zero)

	// Camera coordinate system relative to the tracker
	const cameraAxisX = appConfig.ref<vec3>('tracker.xAxis', vec3.unitX)
	const cameraAxisY = appConfig.ref<vec3>('tracker.yAxis', vec3.unitY)

	const trackerToCameraMatrix = computed(() => {
		// const y = vec3.normalize(cameraAxisY.value)
		// const z = vec3.normalize(vec3.cross(cameraAxisX.value, y))
		// const x = vec3.normalize(vec3.cross(y, z))

		// return mat4.mul(
		// 	mat4.fromAxesTranslation(x, y, z),
		// 	mat4.fromTranslation(cameraOffset.value)
		// )

		const x = vec3.normalize(cameraAxisX.value)
		const y = vec3.normalize(cameraAxisY.value)
		const z = vec3.normalize(vec3.cross(x, y))

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

	const averageSamples = appConfig.ref('tracker.averageSamples', 1)

	const averageTarget = computed(() => {
		const lastTracker = project.shot(project.captureShot.frame - 1, 0)?.tracker

		if (!lastTracker) return null

		const velocities: vec3[] = []
		const rotationVelocities: quat[] = []

		for (let i = 0; i < averageSamples.value; i++) {
			const tracker = project.shot(project.captureShot.frame - 1 - i, 0)
				?.tracker
			const prevTracker = project.shot(project.captureShot.frame - 2 - i, 0)
				?.tracker

			if (tracker && prevTracker) {
				const p = vec3.sub(tracker.position, prevTracker.position)
				velocities.push(p)

				const q = quat.mul(quat.invert(prevTracker.rotation), tracker.rotation)
				rotationVelocities.push(q)
			}
		}

		const averageVelocity = vec3.average(...velocities)
		const averageRotationVelocity = quat.normalize(
			vec4.average(...rotationVelocities)
		)

		return {
			position: vec3.add(lastTracker.position, averageVelocity),
			rotation: quat.mul(lastTracker.rotation, averageRotationVelocity),
		}
	})

	project.shot(project.captureShot.frame - 1, 0)?.tracker
	project.captureShot.frame

	return {
		matrix,
		position,
		rotation,
		groundLevel,

		// Tracker information
		enabled: computed(() => aux.tracker.enabled),
		rawMatrix,

		// Calibration information
		calibrationMatrix,
		setOrigin,
		cameraOffset,
		trackerToCameraMatrix,
		cameraAxisX,
		cameraAxisY,

		// Average information
		averageSamples,
		averageTarget,
	}
})
