<script setup lang="ts">
import {scalar, vec2} from 'linearly'
import {computed} from 'vue'

import {useProjectStore} from '@/stores/project'

interface Props {
	values: unknown[]
	color: string
	valueAtCaptureFrame?: unknown
	fn?: (v: number) => number
}

const props = defineProps<Props>()

const project = useProjectStore()

const mappedValues = computed(() => {
	const {fn} = props
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
			? props.fn?.(props.valueAtCaptureFrame) ?? props.valueAtCaptureFrame
			: null

	const values = [...mappedValues.value]
	values[captureFrame - project.previewRange[0]] = v
	return values
})

const valueRange = computed<[min: number, max: number]>(() => {
	return realtimeValues.value.reduce(
		(acc, v) => {
			if (typeof v !== 'number') return acc
			return [Math.min(acc[0], v), Math.max(acc[1], v)]
		},
		[Infinity, -Infinity] as [number, number]
	)
})

const points = computed(() => {
	const [min, max] = valueRange.value
	const [inPoint] = project.previewRange

	return realtimeValues.value.flatMap((v, x) => {
		if (v === null) return []
		const y = scalar.invlerp(min, max, v)
		return [[x + inPoint, scalar.lerp(0.95, 0.05, y)]] as vec2[]
	})
})

const polylinePoints = computed(() => {
	return points.value.join(' ')
})

const dotsPath = computed(() => {
	return points.value.map(([x, y]) => `M${x},${y} L${x},${y}`).join(' ')
})
</script>

<template>
	<g>
		<polyline class="polyline" :stroke="color" :points="polylinePoints" />
		<path :d="dotsPath" :stroke="color" class="dots" />
	</g>
</template>

<style lang="stylus" scoped>
.polyline, .dots
	fill none
	stroke-linejoin round
	stroke-linecap round
	vector-effect non-scaling-stroke

.polyline
	stroke-width 1px
.dots
	stroke-width 5px
</style>
