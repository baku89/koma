<script setup lang="ts">
import {mat4, vec3} from 'linearly'
import {range} from 'lodash-es'
import {Euler, Quaternion} from 'three'
import {computed} from 'vue'

import {useCameraStore} from '@/stores/camera'
import {useDmxStore} from '@/stores/dmx'
import {useProjectStore} from '@/stores/project'
import {useTimerStore} from '@/stores/timer'
import {useTrackerStore} from '@/stores/tracker'

import TimelineGraphPolyline from './TimelineGraphPolyline.vue'

const project = useProjectStore()
const timer = useTimerStore()
const camera = useCameraStore()
const tracker = useTrackerStore()
const dmx = useDmxStore()

const positionMatrixInverse = computed(() => {
	const m = mat4.clone(tracker.matrix)

	const y = vec3.unitY
	const z = vec3.normalize([m[8], 0, m[10]])
	const x = vec3.cross(y, z)
	const t = mat4.getTranslation(m)

	const matrix = mat4.fromAxesTranslation(x, y, z, t)

	return mat4.invert(matrix) ?? mat4.identity
})

const positions = computed(() => {
	return project.previewKomas.map(koma => {
		const tracker = koma.shots[0]?.tracker
		if (tracker) {
			return mat4.getTranslation(
				mat4.mul(
					positionMatrixInverse.value,
					mat4.fromRotationTranslation(tracker.rotation, tracker.position)
				)
			)
		} else {
			return null
		}
	})
})

const positionsX = computed(() => {
	return positions.value.map(m => m?.[0] ?? null)
})

const positionsY = computed(() => {
	return positions.value.map(m => m?.[1] ?? null)
})

const positionsZ = computed(() => {
	return positions.value.map(m => m?.[2] ?? null)
})

const velocities = computed(() => {
	const [inPoint, outPoint] = project.previewRange

	return range(inPoint, outPoint).map(frame => {
		const position = project.shot(frame, 0)?.tracker?.position
		const prevPosition = project.shot(frame - 1, 0)?.tracker?.position

		if (position && prevPosition) {
			return vec3.sub(position, prevPosition)
		} else {
			return null
		}
	})
})

const currentVelocity = computed(() => {
	const position = project.shot(project.captureShot.frame, 0)?.tracker?.position
	const prevPosition = project.shot(project.captureShot.frame - 1, 0)?.tracker
		?.position

	if (position && prevPosition) {
		return vec3.sub(position, prevPosition)
	} else {
		return null
	}
})

const rotationMatrixInverse = computed(() => {
	return mat4.invert(tracker.matrix) ?? mat4.identity
})

const threeJSEuler = new Euler()
const threeJSQuaternion = new Quaternion()

const rotations = computed(() => {
	return project.previewKomas.map(koma => {
		const tracker = koma.shots[0]?.tracker
		if (tracker) {
			const m = mat4.mul(
				rotationMatrixInverse.value,
				mat4.fromRotationTranslation(tracker.rotation, tracker.position)
			)
			const q = mat4.getRotation(m)
			return threeJSEuler
				.setFromQuaternion(threeJSQuaternion.fromArray([...q]))
				.toArray() as any as vec3
		} else {
			return null
		}
	})
})

const pitches = computed(() => {
	return rotations.value.map(r => (r ? -r[0] : null))
})

const yaws = computed(() => {
	return rotations.value.map(r => (r ? r[1] : null))
})

const rolls = computed(() => {
	return rotations.value.map(r => (r ? r[2] : null))
})

const shootTime = computed(() => {
	return project.previewKomas.map(koma =>
		koma.shots.length > 0
			? koma.shots.reduce((acc, shot) => acc + (shot?.shootTime ?? 0), 0)
			: null
	)
})

const focalLength = computed(() => {
	return project.previewKomas.map(koma => {
		return koma.shots[0]?.cameraConfigs?.focalLength
	})
})

const focusDistance = computed(() => {
	return project.previewKomas.map(koma => {
		return koma.shots[0]?.cameraConfigs?.focusDistance
	})
})

const aperture = computed(() => {
	return project.previewKomas.map(koma => {
		return koma.shots[0]?.cameraConfigs?.aperture
	})
})

const shutterSpeed = computed(() => {
	return project.previewKomas.map(koma => {
		return koma.shots[0]?.cameraConfigs?.shutterSpeed
	})
})

const iso = computed(() => {
	return project.previewKomas.map(koma => {
		return koma.shots[0]?.cameraConfigs?.iso
	})
})

const colorTemperature = computed(() => {
	return project.previewKomas.map(koma => {
		return koma.shots[0]?.cameraConfigs?.colorTemperature ?? null
	})
})

//------------------------------------------------------------------------------
// Tracker Targets

const targetPositions = computed(() => {
	return project.komas.map(koma => {
		const tracker = koma.target?.tracker

		if (tracker) {
			return mat4.getTranslation(
				mat4.mul(
					positionMatrixInverse.value,
					mat4.fromRotationTranslation(tracker.rotation, tracker.position)
				)
			)
		} else {
			return null
		}
	})
})

const targetPositionsX = computed(() => {
	return targetPositions.value.map(m => m?.[0] ?? null)
})
const targetPositionsY = computed(() => {
	return targetPositions.value.map(m => m?.[1] ?? null)
})
const targetPositionsZ = computed(() => {
	return targetPositions.value.map(m => m?.[2] ?? null)
})

const targetRotations = computed(() => {
	return project.komas.map(koma => {
		const tracker = koma.target?.tracker
		if (tracker) {
			const m = mat4.mul(
				rotationMatrixInverse.value,
				mat4.fromRotationTranslation(tracker.rotation, tracker.position)
			)
			const q = mat4.getRotation(m)
			return threeJSEuler
				.setFromQuaternion(threeJSQuaternion.fromArray([...q]))
				.toArray() as any as vec3
		} else {
			return null
		}
	})
})

const targetPitches = computed(() => {
	return targetRotations.value.map(r => (r ? -r[0] : null))
})

const targetYaws = computed(() => {
	return targetRotations.value.map(r => (r ? r[1] : null))
})

const targetRolls = computed(() => {
	return targetRotations.value.map(r => (r ? r[2] : null))
})

//------------------------------------------------------------------------------
// DMX
const dmxValues = computed(() => {
	const visibleAddresses = range(16).filter(
		i => project.visibleProperties[`dmx${i + 1}`]?.visible
	)

	return visibleAddresses.map(i =>
		project.previewKomas.map(koma => koma.shots[0]?.dmx?.at(i) ?? null)
	)
})

//------------------------------------------------------------------------------
// Utils

function isPropertyVisible(name: string) {
	return project.visibleProperties[name]?.visible ?? false
}

function shutterSpeedToString(ss?: string | null) {
	if (typeof ss !== 'string') {
		return null
	} else if (ss.startsWith('1/')) {
		return 1 / parseInt(ss.slice(2))
	} else {
		return /^[0-9]+$/.test(ss) ? parseInt(ss) : null
	}
}

const invLog = (v: number) => -Math.log(v)

const viewBox = computed(() => {
	const [inPoint, outPoint] = project.previewRange
	return `${inPoint} -0.05 ${outPoint - inPoint + 1} 1.1`
})
</script>

<template>
	<svg class="TimelineGraph" :viewBox="viewBox" preserveAspectRatio="none">
		<!-- Camera Configs -->
		<TimelineGraphPolyline
			v-if="isPropertyVisible('focalLength')"
			:values="focalLength"
			:range="[24, 105]"
			:valueAtCaptureFrame="camera.focalLength.value"
			:color="project.visibleProperties.focalLength?.color"
			transform="translate(0, 0) scale(1, 0.7)"
		/>
		<TimelineGraphPolyline
			v-if="isPropertyVisible('focusDistance')"
			:values="focusDistance"
			:valueAtCaptureFrame="camera.focusDistance.value"
			:color="project.visibleProperties.focusDistance?.color"
			transform="translate(0, 0.025) scale(1, 0.7)"
		/>
		<TimelineGraphPolyline
			v-if="isPropertyVisible('aperture')"
			:values="aperture"
			:valueAtCaptureFrame="camera.aperture.value"
			:color="project.visibleProperties.aperture?.color"
			:filter="invLog"
			transform="translate(0, 0.05) scale(1, 0.7)"
		/>
		<TimelineGraphPolyline
			v-if="isPropertyVisible('shutterSpeed')"
			:values="shutterSpeed"
			:valueAtCaptureFrame="shutterSpeedToString(camera.shutterSpeed.value)"
			:color="project.visibleProperties.shutterSpeed?.color"
			:filter="Math.log"
			transform="translate(0, 0.075) scale(1, 0.7)"
		/>
		<TimelineGraphPolyline
			v-if="isPropertyVisible('iso')"
			:values="iso"
			:valueAtCaptureFrame="camera.iso.value"
			:color="project.visibleProperties.iso?.color"
			:filter="Math.log"
			transform="translate(0, 0.1) scale(1, 0.7)"
		/>
		<TimelineGraphPolyline
			v-if="isPropertyVisible('colorTemperature')"
			:values="colorTemperature"
			:valueAtCaptureFrame="camera.colorTemperature.value"
			:color="project.visibleProperties.colorTemperature?.color"
			transform="translate(0, 0.125) scale(1, 0.7)"
		/>
		<!-- Positions -->
		<TimelineGraphPolyline
			:values="positionsX"
			:referenceValues="targetPositionsX"
			:valueAtCaptureFrame="0"
			:minRange="0.1"
			:maxRange="1"
			color="#ff0000"
			style="--stroke-width: 1px"
			transform="translate(0, 0.15) scale(1, 0.7)"
		/>
		<TimelineGraphPolyline
			:values="positionsY"
			:referenceValues="targetPositionsY"
			:valueAtCaptureFrame="0"
			:minRange="0.1"
			:maxRange="1"
			color="#00ff00"
			style="--stroke-width: 1px"
			transform="translate(0, 0.175) scale(1, 0.7)"
		/>
		<TimelineGraphPolyline
			:values="positionsZ"
			:referenceValues="targetPositionsZ"
			:valueAtCaptureFrame="0"
			:minRange="0.1"
			:maxRange="1"
			color="#44f"
			style="--stroke-width: 1px"
			transform="translate(0, 0.2) scale(1, 0.7)"
		/>
		<!-- Rotations -->
		<TimelineGraphPolyline
			:values="pitches"
			:referenceValues="targetPitches"
			:valueAtCaptureFrame="0"
			:minRange="Math.PI / 16"
			color="#afa"
			style="--stroke-dasharray: 4 4; --stroke-width: 1px"
			transform="translate(0, 0.225) scale(1, 0.7)"
		/>
		<TimelineGraphPolyline
			:values="yaws"
			:referenceValues="targetYaws"
			:valueAtCaptureFrame="0"
			:minRange="Math.PI / 16"
			color="#f55"
			style="--stroke-dasharray: 4 4; --stroke-width: 1px"
			transform="translate(0, 0.25) scale(1, 0.7)"
		/>
		<TimelineGraphPolyline
			:values="rolls"
			:referenceValues="targetRolls"
			:valueAtCaptureFrame="0"
			:minRange="Math.PI / 16"
			color="#aaf"
			style="--stroke-dasharray: 4 4; --stroke-width: 1px"
			transform="translate(0, 0.275) scale(1, 0.7)"
		/>
		<TimelineGraphPolyline
			:values="velocities"
			:valueAtCaptureFrame="currentVelocity"
			:minRange="0.1"
			color="#fff"
			transform="translate(0, 0.29) scale(1, 0.7)"
		/>
		<!-- Shoot Time -->
		<TimelineGraphPolyline
			v-if="isPropertyVisible('shootTime')"
			:values="shootTime"
			:valueAtCaptureFrame="timer.current"
			color="#666"
			:minRange="1000 * 60"
			style="--stroke-dasharray: 1 7"
			transform="translate(0, 0.3) scale(1, 0.7)"
		/>
		<!-- DMX -->
		<TimelineGraphPolyline
			v-for="(values, i) in dmxValues"
			:key="i"
			:values="values"
			:valueAtCaptureFrame="dmx.values[i].value"
			:color="project.visibleProperties['dmx' + (i + 1)]?.color ?? 'white'"
			:range="[0, 1]"
			style="--stroke-width: 2px; --stroke-linecap: square"
			transform="translate(0, 0.5) scale(1, 0.5)"
		/>
	</svg>
</template>

<style lang="stylus" scoped>
.TimelineGraph
	position absolute
	top 0
	left calc(var(--in-point) * var(--koma-width))
	width 'calc((var(--out-point) - var(--in-point) + 1) * var(--koma-width))' % ''
	height 100%
	object-fit fill
	overflow visible
	z-index 20
</style>
