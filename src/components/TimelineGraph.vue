<script setup lang="ts">
import {mat4} from 'linearly'
import {Euler, Quaternion} from 'three'
import {computed} from 'vue'

import {useCameraStore} from '@/stores/camera'
import {useProjectStore} from '@/stores/project'
import {useTimerStore} from '@/stores/timer'
import {useTrackerStore} from '@/stores/tracker'

import TimelineGraphPolyline from './TimelineGraphPolyline.vue'

const project = useProjectStore()
const timer = useTimerStore()
const camera = useCameraStore()
const tracker = useTrackerStore()

const previewKomas = computed(() => {
	const [inPoint, outPoint] = project.previewRange
	return project.allKomas.slice(inPoint, outPoint + 1)
})

const trackerMatrixInverse = computed(() => {
	return mat4.invert(tracker.matrix) ?? mat4.identity
})

const trackerMatrices = computed(() => {
	return previewKomas.value.map(koma => {
		const tracker = koma.shots[0]?.tracker
		if (tracker) {
			return mat4.mul(
				trackerMatrixInverse.value,
				mat4.fromRotationTranslation(tracker.rotation, tracker.position)
			)
		} else {
			return mat4.identity
		}
	})
})

const positionX = computed(() => {
	return trackerMatrices.value.map(m => m[12])
})

const positionY = computed(() => {
	return trackerMatrices.value.map(m => m[13])
})

const positionZ = computed(() => {
	return trackerMatrices.value.map(m => m[14])
})

const _euler = new Euler()
const _quat = new Quaternion()

const trackerRotations = computed(() => {
	return trackerMatrices.value.map(m => {
		const q = mat4.getRotation(m)
		return _euler.setFromQuaternion(_quat.fromArray(q)).toArray()
	})
})

const pitches = computed(() => {
	return trackerRotations.value.map(r => r[0])
})

const yaws = computed(() => {
	return trackerRotations.value.map(r => r[1])
})

const rolls = computed(() => {
	return trackerRotations.value.map(r => r[2])
})

const shootTime = computed(() => {
	return previewKomas.value.map(koma =>
		koma.shots.length > 0
			? koma.shots.reduce((acc, shot) => acc + (shot?.shootTime ?? 0), 0)
			: null
	)
})

const focalLength = computed(() => {
	return previewKomas.value.map(koma => {
		return koma.shots[0]?.cameraConfigs.focalLength
	})
})

const focusDistance = computed(() => {
	return previewKomas.value.map(koma => {
		return koma.shots[0]?.cameraConfigs.focusDistance
	})
})

const aperture = computed(() => {
	return previewKomas.value.map(koma => {
		return koma.shots[0]?.cameraConfigs.aperture
	})
})

const shutterSpeed = computed(() => {
	return previewKomas.value.map(koma => {
		return koma.shots[0]?.cameraConfigs.shutterSpeed
	})
})

const iso = computed(() => {
	return previewKomas.value.map(koma => {
		return koma.shots[0]?.cameraConfigs.iso
	})
})

const colorTemperature = computed(() => {
	return previewKomas.value.map(koma => {
		return koma.shots[0]?.cameraConfigs.colorTemperature ?? null
	})
})

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
		<TimelineGraphPolyline
			v-if="isPropertyVisible('focalLength')"
			:values="focalLength"
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
		<TimelineGraphPolyline
			:values="positionX"
			:valueAtCaptureFrame="0"
			color="#ff0000"
			style="--stroke-width: 2px"
			transform="translate(0, 0.15) scale(1, 0.7)"
		/>
		<TimelineGraphPolyline
			:values="positionY"
			:valueAtCaptureFrame="0"
			color="#00ff00"
			style="--stroke-width: 2px"
			transform="translate(0, 0.175) scale(1, 0.7)"
		/>
		<TimelineGraphPolyline
			:values="positionZ"
			:valueAtCaptureFrame="0"
			color="#44f"
			style="--stroke-width: 2px"
			transform="translate(0, 0.2) scale(1, 0.7)"
		/>
		<TimelineGraphPolyline
			:values="pitches"
			:valueAtCaptureFrame="0"
			color="#afa"
			style="--stroke-dasharray: 4 4; --stroke-width: 2px"
			transform="translate(0, 0.225) scale(1, 0.7)"
		/>
		<TimelineGraphPolyline
			:values="yaws"
			:valueAtCaptureFrame="0"
			color="#f55"
			style="--stroke-dasharray: 4 4; --stroke-width: 2px"
			transform="translate(0, 0.225) scale(1, 0.7)"
		/>
		<TimelineGraphPolyline
			:values="rolls"
			:valueAtCaptureFrame="0"
			color="#aaf"
			style="--stroke-dasharray: 4 4; --stroke-width: 2px"
			transform="translate(0, 0.225) scale(1, 0.7)"
		/>
		<TimelineGraphPolyline
			v-if="isPropertyVisible('shootTime')"
			:values="shootTime"
			:valueAtCaptureFrame="timer.current"
			:color="project.visibleProperties.shootTime?.color"
			style="--stroke-dasharray: 1 5"
			transform="translate(0, 0.3) scale(1, 0.7)"
		/>
	</svg>
</template>

<style lang="stylus" scoped>
.TimelineGraph
	position absolute
	top 0
	left calc(var(--in-point) * var(--koma-width))
	width calc((var(--out-point) - var(--in-point) + 1) * var(--koma-width))
	height 100%
	object-fit fill
	overflow visible
</style>
