<script setup lang="ts">
import {computed} from 'vue'

import {useCameraStore} from '@/stores/camera'
import {useProjectStore} from '@/stores/project'
import {useTimerStore} from '@/stores/timer'

import TimelineGraphPolyline from './TimelineGraphPolyline.vue'

const project = useProjectStore()
const timer = useTimerStore()
const camera = useCameraStore()

const shootTime = computed(() => {
	return project.allKomas.map(koma =>
		koma.shots.length > 0
			? koma.shots.reduce((acc, shot) => acc + (shot?.shootTime ?? 0), 0)
			: null
	)
})

const focalLength = computed(() => {
	return project.allKomas.map(koma => {
		const value = koma.shots[0]?.cameraConfigs.focalLength
		return typeof value === 'number' ? value : null
	})
})

const focusDistance = computed(() => {
	return project.allKomas.map(koma => {
		const value = koma.shots[0]?.cameraConfigs.focusDistance
		return typeof value === 'number' ? value : null
	})
})

const aperture = computed(() => {
	return project.allKomas.map(koma => {
		const value = koma.shots[0]?.cameraConfigs.aperture
		return logValue(value, true)
	})
})

const shutterSpeed = computed(() => {
	return project.allKomas.map(koma => {
		const value = koma.shots[0]?.cameraConfigs.shutterSpeed
		return shutterSpeedToString(value)
	})
})

const iso = computed(() => {
	return project.allKomas.map(koma => {
		const value = koma.shots[0]?.cameraConfigs.iso
		return logValue(value)
	})
})

const colorTemperature = computed(() => {
	return project.allKomas.map(koma => {
		return koma.shots[0]?.cameraConfigs.colorTemperature ?? null
	})
})

function logValue(value: unknown, invert = false) {
	const sign = invert ? -1 : 1
	return typeof value === 'number' ? sign * Math.log(value) : null
}

function isPropertyVisible(name: string) {
	return project.visibleProperties[name]?.visible ?? false
}

function shutterSpeedToString(ss?: string | null) {
	if (typeof ss !== 'string') {
		return null
	} else if (ss.startsWith('1/')) {
		return logValue(1 / parseInt(ss.slice(2)))
	} else {
		return /^[0-9]+$/.test(ss) ? logValue(parseInt(ss)) : null
	}
}
</script>

<template>
	<svg class="TimelineGraph" viewBox="0 0 1 1" preserveAspectRatio="none">
		<TimelineGraphPolyline
			v-if="isPropertyVisible('shootTime')"
			:values="shootTime"
			:valueAtCaptureFrame="timer.current"
			:color="project.visibleProperties.shootTime?.color"
		/>
		<TimelineGraphPolyline
			v-if="isPropertyVisible('focalLength')"
			:values="focalLength"
			:valueAtCaptureFrame="camera.focalLength.value"
			:color="project.visibleProperties.focalLength?.color"
		/>
		<TimelineGraphPolyline
			v-if="isPropertyVisible('focusDistance')"
			:values="focusDistance"
			:valueAtCaptureFrame="camera.focusDistance.value"
			:color="project.visibleProperties.focusDistance?.color"
		/>
		<TimelineGraphPolyline
			v-if="isPropertyVisible('aperture')"
			:values="aperture"
			:valueAtCaptureFrame="logValue(camera.aperture.value, true)"
			:color="project.visibleProperties.aperture?.color"
		/>
		<TimelineGraphPolyline
			v-if="isPropertyVisible('shutterSpeed')"
			:values="shutterSpeed"
			:valueAtCaptureFrame="shutterSpeedToString(camera.shutterSpeed.value)"
			:color="project.visibleProperties.shutterSpeed?.color"
		/>
		<TimelineGraphPolyline
			v-if="isPropertyVisible('iso')"
			:values="iso"
			:valueAtCaptureFrame="logValue(camera.iso.value)"
			:color="project.visibleProperties.iso?.color"
		/>
		<TimelineGraphPolyline
			v-if="isPropertyVisible('colorTemperature')"
			:values="colorTemperature"
			:valueAtCaptureFrame="camera.colorTemperature.value"
			:color="project.visibleProperties.colorTemperature?.color"
		/>
		/>
	</svg>
</template>

<style lang="stylus" scoped>
.TimelineGraph
	position absolute
	top 0
	left 0
	width 100%
	height 100%
	object-fit fill
	overflow visible
</style>
