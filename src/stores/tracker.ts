import {mat4, quat, vec3, vec4} from 'linearly'
import {defineStore} from 'pinia'
import {useTweeq} from 'tweeq'
import {computed} from 'vue'

import {useAuxDevicesStore} from './auxDevices'
import {useProjectStore} from './project'

export const useTrackerStore = defineStore('tracker', () => {
	const aux = useAuxDevicesStore()
	const project = useProjectStore()
	const config = useTweeq().config.group('tracker')

	const groundLevel = config.ref('groundLevel', 0)

	const originMatrix = config.ref<mat4>('originMatrix', mat4.identity)

	const originMatrixInverse = computed(() => {
		return mat4.invert(originMatrix.value) ?? mat4.ident
	})

	const cameraOffset = config.ref<vec3>('offset', vec3.zero)

	// Camera coordinate system relative to the tracker
	const cameraAxisX = config.ref<vec3>('xAxis', vec3.unitX)
	const cameraAxisY = config.ref<vec3>('yAxis', vec3.unitY)

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

	const trackerToCameraMatrixInverse = computed(() => {
		return mat4.invert(trackerToCameraMatrix.value) ?? mat4.ident
	})

	const rawMatrix = computed(() => {
		return mat4.fromRotationTranslation(
			aux.tracker.rotation,
			aux.tracker.position
		)
	})

	function compensateRawMatrix(rawMatrix: mat4) {
		return mat4.mul(
			trackerToCameraMatrixInverse.value,
			originMatrixInverse.value,
			rawMatrix,
			trackerToCameraMatrix.value
		)
	}

	const matrix = computed(() => {
		return compensateRawMatrix(rawMatrix.value)
	})

	const position = computed(() => {
		return mat4.getTranslation(matrix.value)
	})

	const rotation = computed(() => {
		return mat4.getRotation(matrix.value)
	})

	const averageSamples = config.ref('tracker.averageSamples', 1)

	const averageTarget = computed(() => {
		const lastTracker = project.shot(project.captureShot.frame - 1, 0)?.tracker

		if (!lastTracker) return null

		const velocities: vec3[] = []
		const rotationVelocities: quat[] = []

		for (let i = 0; i < averageSamples.value; i++) {
			const tracker = project.shot(
				project.captureShot.frame - 1 - i,
				0
			)?.tracker
			const prevTracker = project.shot(
				project.captureShot.frame - 2 - i,
				0
			)?.tracker

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

	/**
	 * Receives two matrices in the camera coordinate system and calibrates the origin matrix so that the source matrix matches the destination matrix.
	 * @param srcMatrix A source matrix in the camera coordinate system
	 * @param destMatrix A destination matrix in the camera coordinate system
	 */
	function calibrateOriginMatrix(srcMatrix: mat4, destMatrix: mat4) {
		originMatrix.value = mat4.mul(
			originMatrix.value,
			trackerToCameraMatrix.value,
			srcMatrix,
			mat4.invert(destMatrix) ?? mat4.ident,
			trackerToCameraMatrixInverse.value
		)
	}

	return {
		/**
		 * The calibrated matrix considering origin and camera offset
		 */
		matrix,
		/**
		 * The calibrated position of the camera
		 */
		position,
		/**
		 * The calibrated rotation of the camera
		 */
		rotation,
		/**
		 * The ground level of the tracking space
		 */
		groundLevel,

		velocity: aux.tracker.velocity,

		/**
		 * Whether the tracker is enabled
		 */
		enabled: computed(() => aux.tracker.enabled),

		/**
		 * The raw matrix from the tracker
		 */
		rawMatrix,

		// Calibration information
		originMatrix,
		cameraOffset,
		trackerToCameraMatrixInverse,
		trackerToCameraMatrix,
		compensateRawMatrix,
		calibrateOriginMatrix,

		/**
		 * X-direction of camera coordinate system relative to the tracker
		 */
		cameraAxisX,
		/**
		 * Y-direction of camera coordinate system relative to the tracker
		 */
		cameraAxisY,

		// Average information
		averageSamples,
		averageTarget,
	}
})
