<script setup lang="ts">
import {scalar, vec2} from 'linearly'
import {computed} from 'vue'

import {useProjectStore} from '@/stores/project'

interface Props {
	values: unknown[]
	color: string
	valueAtCaptureFrame?: unknown
	minRange?: number
	filter?: (v: number) => number
}

const props = withDefaults(defineProps<Props>(), {minRange: 0.01})

const project = useProjectStore()

const mappedValues = computed(() => {
	const {filter: fn} = props
	if (fn) {
		return props.values.map(v => (typeof v === 'number' ? fn(v) : null))
	} else {
		return props.values.map(v => (typeof v === 'number' ? v : null))
	}
})

const realtimeValues = computed(() => {
	const captureFrame = project.captureShot.frame

	if (
		typeof props.valueAtCaptureFrame !== 'number' ||
		captureFrame < project.previewRange[0] ||
		project.previewRange[1] < captureFrame
	) {
		return mappedValues.value
	}

	const v =
		typeof props.valueAtCaptureFrame === 'number'
			? props.filter?.(props.valueAtCaptureFrame) ?? props.valueAtCaptureFrame
			: null

	const values = [...mappedValues.value]
	values[captureFrame - project.previewRange[0]] = v
	return values
})

const valueRange = computed<[min: number, max: number]>(() => {
	let min = Infinity
	let max = -Infinity

	for (const v of realtimeValues.value) {
		if (typeof v !== 'number') continue
		min = Math.min(min, v)
		max = Math.max(max, v)
	}

	if (max - min < props.minRange) {
		const mid = (max + min) / 2
		min = mid - props.minRange / 2
		max = mid + props.minRange / 2
	}

	return [min, max]
})

const points = computed(() => {
	const [min, max] = valueRange.value
	const [inPoint] = project.previewRange

	const points: vec2[] = []

	for (const [i, v] of realtimeValues.value.entries()) {
		if (v === null) continue
		const x = i + inPoint
		const y = scalar.invlerp(max, min, v)

		points.push([x, y])
	}

	return points
})

const polylinePath = computed(() => {
	const commands: string[] = []

	const firstPoint = points.value[0] ?? [NaN, NaN]

	let prevX = firstPoint[0]
	let prevY = firstPoint[1]
	let drawing = false

	for (const [x, y] of points.value) {
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
})

const dotsPath = computed(() => {
	const _points = points.value

	const filteredPoints = _points.filter(([, y], i) => {
		const prevY = _points[i - 1]?.at(1) ?? y
		const nextY = _points[i + 1]?.at(1) ?? y

		if (prevY === y && y === nextY) return false

		return true
	})

	return filteredPoints.map(([x, y]) => `M${x},${y} L${x},${y}`).join(' ')
})
</script>

<template>
	<g :stroke="color">
		<path class="polyline" :d="polylinePath" />
		<path class="dots" :d="dotsPath" />
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
</style>
