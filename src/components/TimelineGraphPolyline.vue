<script setup lang="ts">
import {scalar} from 'linearly'
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
	if (!fn) return props.values.map(v => (typeof v === 'number' ? v : null))
	return props.values.map(v => (typeof v === 'number' ? fn(v) : null))
})

const realtimeValues = computed(() => {
	if (typeof props.valueAtCaptureFrame !== 'number') return mappedValues.value

	const v =
		typeof props.valueAtCaptureFrame === 'number'
			? props.fn?.(props.valueAtCaptureFrame) ?? props.valueAtCaptureFrame
			: null

	const values = [...mappedValues.value]
	values[project.captureShot.frame] = v
	return values
})

const valueRange = computed<[min: number, max: number]>(() => {
	const [inPoint, outPoint] = project.previewRange

	const sliced = realtimeValues.value.slice(inPoint, outPoint + 1)

	return sliced.reduce(
		(acc, v) => {
			if (typeof v !== 'number') return acc
			return [Math.min(acc[0], v), Math.max(acc[1], v)]
		},
		[Infinity, -Infinity] as [number, number]
	)
})

const points = computed(() => {
	const [min, max] = valueRange.value
	return valuesToPath(realtimeValues.value, min, max)
})

function valuesToPath(values: (number | null)[], min: number, max: number) {
	const len = values.length || 1
	return values
		.map((v, x) => {
			if (v === null) return
			const y = scalar.invlerp(min, max, v)
			return `${x / len},${scalar.lerp(0.95, 0.05, y)}`
		})
		.join(' ')
}
</script>

<template>
	<polyline class="TimelineGraphPolyline" :stroke="color" :points="points" />
</template>

<style lang="stylus" scoped>
.TimelineGraphPolyline
	stroke-width 2px
	fill none
	stroke-linejoin round
	stroke-linecap round
	vector-effect non-scaling-stroke
</style>
