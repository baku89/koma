<script setup lang="ts">
import {mat4, vec2, vec3} from 'linearly'
import {identity} from 'lodash-es'
import {ShutterSpeed} from 'tethr'
import {Euler, Quaternion} from 'three'
import {computed} from 'vue'

import {useCameraStore} from '@/stores/camera'
import {useDmxStore} from '@/stores/dmx'
import {Koma, useProjectStore} from '@/stores/project'
import {useTrackerStore} from '@/stores/tracker'

import LineGraph from '../LineGraph.vue'

const project = useProjectStore()
const camera = useCameraStore()
const tracker = useTrackerStore()
const dmx = useDmxStore()

const positionMatrixInverse = computed(() => {
	// 現在のトラッカーからの位置をベースに、Y軸のみ上向きになるような座標系を作る
	// この座標系を基準として、previewRangeの範囲内での各コマの位置を表示する
	const m = mat4.clone(tracker.matrix)

	const y = vec3.unitY
	const z = vec3.normalize([m[8], 0, m[10]])
	const x = vec3.cross(y, z)
	const t = mat4.getTranslation(m)

	const matrix = mat4.fromAxesTranslation(x, y, z, t)

	return mat4.invert(matrix) ?? mat4.identity
})

const positions = computed(() => {
	const [inPoint] = project.previewRange

	return project.previewKomas
		.map((koma, i) => {
			const frame = inPoint + i

			if (frame === project.captureShot.frame) {
				// 撮影コマを原点とする
				return [frame, vec3.zero] as const
			}

			const tracker = koma.shots[0]?.tracker
			if (!tracker) return null

			const p = mat4.getTranslation(
				mat4.mul(
					positionMatrixInverse.value,
					mat4.fromRotationTranslation(tracker.rotation, tracker.position)
				)
			)

			return [frame, p] as const
		})
		.filter(k => k !== null)
})

const positionsX = computed<vec2[]>(() => {
	return positions.value.map(([frame, p]) => [frame, p[0]])
})

const positionsY = computed<vec2[]>(() => {
	return positions.value.map(([frame, p]) => [frame, p[1]])
})

const positionsZ = computed<vec2[]>(() => {
	return positions.value.map(([frame, p]) => [frame, p[2]])
})

/*
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
	*/

const rotationMatrixInverse = computed(() => {
	return mat4.invert(tracker.matrix) ?? mat4.identity
})

const threeJSEuler = new Euler()
const threeJSQuaternion = new Quaternion()

const rotations = computed(() => {
	const [inPoint] = project.previewRange

	return project.previewKomas
		.map((koma, i) => {
			const frame = inPoint + i

			const tracker = koma.shots[0]?.tracker
			if (!tracker) {
				return null
			}

			const m = mat4.mul(
				rotationMatrixInverse.value,
				mat4.fromRotationTranslation(tracker.rotation, tracker.position)
			)
			const q = mat4.getRotation(m)
			const euler = threeJSEuler
				.setFromQuaternion(threeJSQuaternion.fromArray([...q]))
				.toArray() as any as vec3

			return [frame, euler] as const
		})
		.filter(k => k !== null)
})

const pitches = computed<vec2[]>(() => {
	return rotations.value.map(([frame, e]) => [frame, e[0]])
})

const yaws = computed<vec2[]>(() => {
	return rotations.value.map(([frame, e]) => [frame, e[1]])
})

const rolls = computed<vec2[]>(() => {
	return rotations.value.map(([frame, e]) => [frame, e[2]])
})

const focalLength = useGraphPoints({
	komaToValue: koma => koma.shots[0]?.cameraConfigs?.focalLength,
	captureShotValue: () => camera.focalLength.value,
})

const focusDistance = useGraphPoints({
	komaToValue: koma => koma.shots[0]?.cameraConfigs?.focusDistance,
	captureShotValue: () => camera.focusDistance.value,
})

const aperture = useGraphPoints({
	komaToValue: koma => koma.shots[0]?.cameraConfigs?.aperture,
	captureShotValue: () => camera.aperture.value,
	map: invLog,
})

const shutterSpeed = useGraphPoints({
	komaToValue: koma => koma.shots[0]?.cameraConfigs?.shutterSpeed,
	captureShotValue: () => camera.shutterSpeed.value,
	toNumber: shutterSpeedToSeconds,
	map: Math.log,
})

const iso = useGraphPoints({
	komaToValue: koma => koma.shots[0]?.cameraConfigs?.iso,
	captureShotValue: () => camera.iso.value,
	map: Math.log,
})

const colorTemperature = useGraphPoints({
	komaToValue: koma => koma.shots[0]?.cameraConfigs?.colorTemperature,
	captureShotValue: () => camera.colorTemperature.value,
})

//------------------------------------------------------------------------------
// Utils

function defaultToNumber(value: any): number | null {
	return typeof value === 'number' ? value : null
}

function useGraphPoints<T>({
	komaToValue,
	captureShotValue,
	toNumber = defaultToNumber,
	map = identity,
}: {
	komaToValue: (koma: Koma) => T | null | undefined
	captureShotValue: () => T | null | undefined
	toNumber?: (value: T) => number | null
	map?: (value: number) => number
}) {
	function convert(value: T | null | undefined) {
		if (value === null || value === undefined) {
			return null
		}

		const numberValue = toNumber(value)
		return numberValue === null ? null : map(numberValue)
	}

	return computed<(readonly [frame: number, value: V])[]>(() => {
		const [inPoint] = project.previewRange

		return project.previewKomas
			.map((koma, i) => {
				const frame = inPoint + i

				if (frame === project.captureShot.frame) {
					const value = convert(captureShotValue())
					return value === null ? null : ([frame, value] as const)
				}

				const value = convert(komaToValue(koma))

				return value === null ? null : ([frame, value] as const)
			})
			.filter(k => k !== null)
	})
}

function isPropertyVisible(name: string) {
	return project.visibleProperties[name]?.visible ?? false
}

function shutterSpeedToSeconds(ss?: ShutterSpeed | null) {
	if (typeof ss !== 'string') {
		return null
	} else if (ss.startsWith('1/')) {
		return 1 / parseInt(ss.slice(2))
	} else {
		return /^[0-9]+$/.test(ss) ? parseInt(ss) : null
	}
}

function invLog(v: number) {
	return -Math.log(v)
}

const viewBox = computed(() => {
	const [inPoint, outPoint] = project.previewRange
	return `${inPoint} 0 ${outPoint - inPoint + 1} 1`
})
</script>

<template>
	<svg class="TimelineGraph" :viewBox="viewBox" preserveAspectRatio="none">
		<!-- Camera Configs -->
		<LineGraph
			v-if="isPropertyVisible('focalLength')"
			:points="focalLength"
			:minRange="[18, 105]"
			:stroke="project.visibleProperties.focalLength?.color"
		/>
		<LineGraph
			v-if="isPropertyVisible('focusDistance')"
			:points="focusDistance"
			:stroke="project.visibleProperties.focusDistance?.color"
		/>
		<LineGraph
			v-if="isPropertyVisible('aperture')"
			:points="aperture"
			:stroke="project.visibleProperties.aperture?.color"
		/>
		<LineGraph
			v-if="isPropertyVisible('shutterSpeed')"
			:points="shutterSpeed"
			:stroke="project.visibleProperties.shutterSpeed?.color"
		/>
		<LineGraph
			v-if="isPropertyVisible('iso')"
			:points="iso"
			:stroke="project.visibleProperties.iso?.color"
		/>
		<LineGraph
			v-if="isPropertyVisible('colorTemperature')"
			:points="colorTemperature"
			:stroke="project.visibleProperties.colorTemperature?.color"
		/>
		<!-- Positions -->
		<LineGraph :points="positionsX" :minRangeWidth="0.5" stroke="#ff0000" />
		<LineGraph :points="positionsY" :minRangeWidth="0.25" stroke="#00ff00" />
		<LineGraph :points="positionsZ" :minRangeWidth="0.5" stroke="#44f" />
		<!-- Rotations -->
		<LineGraph
			:points="pitches"
			:minRangeWidth="Math.PI / 8"
			stroke="#afa"
			stroke-dasharray="4 4"
		/>
		<LineGraph
			:points="yaws"
			:minRangeWidth="Math.PI / 8"
			stroke="#f55"
			stroke-dasharray="4 4"
		/>
		<LineGraph
			:points="rolls"
			:minRangeWidth="Math.PI / 8"
			stroke="#aaf"
			stroke-dasharray="4 4"
		/>
		<!--
		<LineGraph
			:points="velocities"
			:valueAtCaptureFrame="currentVelocity"
			stroke="#fff"
		/>
		-->
		<!-- DMX -->
		<!--<LineGraph
			v-for="(values, i) in dmxValues"
			:key="i"
			:points="values"
			:valueAtCaptureFrame="dmx.values[i].value"
			:stroke="project.visibleProperties['dmx' + (i + 1)]?.color ?? 'white'"
			:range="[0, 1]"
			stroke-width="2"
			stroke-linecap="square"
		/>-->
	</svg>
</template>

<style lang="stylus" scoped>
.TimelineGraph
	position absolute
	top 0
	height 100%
	object-fit fill
	overflow visible
</style>
