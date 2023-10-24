<script setup lang="ts">
import {computed} from 'vue'

import {useCameraStore} from '@/stores/camera'
import {useProjectStore} from '@/stores/project'
import {useTimerStore} from '@/stores/timer'

import TimelineGraphPolyline from './TimelineGraphPolyline.vue'

const project = useProjectStore()
const timer = useTimerStore()
const camera = useCameraStore()

const previewKomas = computed(() => {
	const [inPoint, outPoint] = project.previewRange
	return project.allKomas.slice(inPoint, outPoint + 1)
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
	return `${inPoint} 0 ${outPoint - inPoint + 1} 1`
})
</script>

<template>
	<svg class="TimelineGraph" :viewBox="viewBox" preserveAspectRatio="none">
		<defs>
			<marker
				id="circle"
				viewBox="0 0 12 12"
				refX="6"
				refY="6"
				markerWidth="30"
				markerHeight="5"
				markerUnits="strokeWidth"
				fill="red"
			>
				<circle cx="6" cy="6" r="5" />
			</marker>
		</defs>
		<TimelineGraphPolyline
			v-if="isPropertyVisible('shootTime')"
			:values="shootTime"
			:valueAtCaptureFrame="timer.current"
			:color="project.visibleProperties.shootTime?.color"
			transform="translate(0, 0.2) scale(1, 0.8)"
		/>
		<TimelineGraphPolyline
			v-if="isPropertyVisible('focalLength')"
			:values="focalLength"
			:valueAtCaptureFrame="camera.focalLength.value"
			:color="project.visibleProperties.focalLength?.color"
			transform="translate(0, 0) scale(1, 0.8)"
		/>
		<TimelineGraphPolyline
			v-if="isPropertyVisible('focusDistance')"
			:values="focusDistance"
			:valueAtCaptureFrame="camera.focusDistance.value"
			:color="project.visibleProperties.focusDistance?.color"
			transform="translate(0, 0.025) scale(1, 0.8)"
		/>
		<TimelineGraphPolyline
			v-if="isPropertyVisible('aperture')"
			:values="aperture"
			:valueAtCaptureFrame="camera.aperture.value"
			:color="project.visibleProperties.aperture?.color"
			:fn="invLog"
			transform="translate(0, 0.05) scale(1, 0.8)"
		/>
		<TimelineGraphPolyline
			v-if="isPropertyVisible('shutterSpeed')"
			:values="shutterSpeed"
			:valueAtCaptureFrame="shutterSpeedToString(camera.shutterSpeed.value)"
			:color="project.visibleProperties.shutterSpeed?.color"
			:fn="Math.log"
			transform="translate(0, 0.075) scale(1, 0.8)"
		/>
		<TimelineGraphPolyline
			v-if="isPropertyVisible('iso')"
			:values="iso"
			:valueAtCaptureFrame="camera.iso.value"
			:color="project.visibleProperties.iso?.color"
			:fn="Math.log"
			transform="translate(0, 0.1) scale(1, 0.8)"
		/>
		<TimelineGraphPolyline
			v-if="isPropertyVisible('colorTemperature')"
			:values="colorTemperature"
			:valueAtCaptureFrame="camera.colorTemperature.value"
			:color="project.visibleProperties.colorTemperature?.color"
			transform="translate(0, 0.125) scale(1, 0.8)"
		/>
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
