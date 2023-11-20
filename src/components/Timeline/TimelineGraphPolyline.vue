<script setup lang="ts">
import {scalar, vec2} from 'linearly'
import {isNumber} from 'lodash'
import {computed} from 'vue'

import {useProjectStore} from '@/stores/project'

interface Props {
	values: unknown[]
	referenceValues?: unknown[]
	color: string
	valueAtCaptureFrame?: unknown
	minRange?: number
	maxRange?: number
	startFrame?: number
	filter?: (v: number) => number
}

const props = withDefaults(defineProps<Props>(), {
	minRange: 0.01,
	maxRange: 100000,
})

const project = useProjectStore()

const filterFn = computed(
	() => (v: unknown) => (typeof v === 'number' ? props.filter?.(v) ?? v : null)
)

// Captured values
const capturedValues = computed(() => {
	return props.values.map(filterFn.value)
})

const capturedRange = computed(() => {
	const numericValues = capturedValues.value.filter(isNumber)

	const min = Math.min(...numericValues)
	const max = Math.max(...numericValues)

	return [min, max] as const
})

const realtimeValues = computed(() => {
	const v = filterFn.value(props.valueAtCaptureFrame)
	const i = project.captureShot.frame - project.previewRange[0]

	if (i < 0 || i >= capturedValues.value.length) return capturedValues.value

	const values = [...capturedValues.value]
	values[i] = v
	return values
})

const rangeComputed = computed<[min: number, max: number]>(() => {
	let [min, max] = capturedRange.value

	if (max - min < props.minRange) {
		const mid = (max + min) / 2
		min = mid - props.minRange / 2
		max = mid + props.minRange / 2
	}
	if (typeof props.valueAtCaptureFrame === 'number') {
		if (max - props.valueAtCaptureFrame > props.maxRange) {
			max = props.valueAtCaptureFrame + props.maxRange
		} else if (props.valueAtCaptureFrame - min > props.maxRange) {
			min = props.valueAtCaptureFrame - props.maxRange
		}
	}
	return [min, max]
})

const points = computed(() => {
	return convertValuesToPoints(realtimeValues.value, project.previewRange[0])
})

const polylinePath = computed(() => convertToPolylinePath(points.value))
const dotsPath = computed(() => convertToDotsPath(points.value))

// Reference values
const referencePoints = computed(() => {
	const points = props.referenceValues?.map(filterFn.value) ?? []

	return convertValuesToPoints(points, 0)
})

const referencePolylinePath = computed(() =>
	convertToPolylinePath(referencePoints.value)
)
const referenceDotsPath = computed(() =>
	convertToDotsPath(referencePoints.value)
)

//------------------------------------------------------------------------------
// Helpers

function convertValuesToPoints(values: (number | null)[], startFrame: number) {
	const [min, max] = rangeComputed.value

	const points: vec2[] = []

	for (const [i, v] of values.entries()) {
		if (v === null) continue
		const x = i + startFrame
		const y = scalar.invlerp(max, min, v)

		points.push([x, y])
	}

	return points
}

function convertToPolylinePath(points: vec2[]) {
	const commands: string[] = []

	const firstPoint = points[0] ?? [NaN, NaN]

	let prevX = firstPoint[0]
	let prevY = firstPoint[1]
	let drawing = false

	for (const [x, y] of points) {
		if (prevY !== y) {
			if (!drawing) {
				commands.push(`M${prevX},${prevY}`)
			}
			commands.push(`L${x},${y}`)
			drawing = true
		} else {
			drawing = false
		}

		prevX = x
		prevY = y
	}

	return commands.join(' ')
}

function convertToDotsPath(points: vec2[]) {
	const filteredPoints = points.filter(([, y], i) => {
		const prevY = points[i - 1]?.at(1) ?? y
		const nextY = points[i + 1]?.at(1) ?? y

		if (prevY === y && y === nextY) return false

		return true
	})

	return filteredPoints.map(([x, y]) => `M${x},${y} L${x},${y}`).join(' ')
}
</script>

<template>
	<g :stroke="color">
		<path class="polyline" :d="polylinePath" />
		<path class="dots" :d="dotsPath" />
		<path class="polyline reference" :d="referencePolylinePath" />
		<path class="dots reference" :d="referenceDotsPath" />
	</g>
</template>

<style lang="stylus" scoped>
.polyline
.dots
	fill none
	vector-effect non-scaling-stroke

.polyline
	stroke-linejoin round
	stroke-linecap round
	stroke-width var(--stroke-width, 1px)
	stroke-dasharray var(--stroke-dasharray, none)
.dots
	stroke-linecap var(--stroke-linecap, round)
	stroke-width calc(var(--stroke-width, 1px) + 5px)

.reference
	opacity 0.4
</style>
