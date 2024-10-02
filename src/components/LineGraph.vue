<script setup lang="ts">
import {vec2} from 'linearly'
import {computed} from 'vue'

interface Props {
	/**
	 * グラフの点の座標。昇順である必要がある
	 */
	points: vec2[]
	/**
	 * グラフとして表示する最小の値域
	 */
	minRange?: vec2
	/**
	 * 最小の値域の幅
	 */
	minRangeWidth?: number
}

const props = withDefaults(defineProps<Props>(), {
	minRangeWidth: 0.1,
})

const polyline = computed(() => {
	const {points} = props

	const commands: string[] = []

	let prevValue: null | number = null
	let cmd = 'M'

	for (const [domain, value] of points) {
		if (prevValue === value) {
			// Skip horizontal lines
			cmd = 'M'
		}

		commands.push(`${cmd}${domain} ${value}`)

		cmd = 'L'
		prevValue = value
	}

	return commands.join(' ')
})

const dots = computed(() => {
	const {points} = props

	const filteredPoints = props.points.filter(([, y], i) => {
		const prevY = points[i - 1]?.at(1) ?? y
		const nextY = points[i + 1]?.at(1) ?? y

		return prevY !== y || y !== nextY
	})

	return filteredPoints.map(([x, y]) => `M${x},${y} L${x},${y}`).join(' ')
})

const range = computed(() => {
	const yValues = props.points.map(p => p[1])

	const min = Math.min(...yValues, props.minRange?.[0] ?? Infinity)
	const max = Math.max(...yValues, props.minRange?.[1] ?? -Infinity)

	if (!isFinite(min) || !isFinite(max)) {
		return [0, 1]
	}

	if (max - min < props.minRangeWidth) {
		const half = props.minRangeWidth / 2
		return [min - half, max + half]
	}

	return [min, max]
})

const scaleY = computed(() => {
	const [min, max] = range.value
	return 1 / (max - min)
})
</script>

<template>
	<g :transform="`scale(1, ${scaleY}) translate(0, ${-range[0]})`">
		<path class="polyline" :d="polyline" />
		<path class="dots" :d="dots" />
	</g>
</template>

<style lang="stylus" scoped>
.polyline
.dots
	fill none
	vector-effect non-scaling-stroke
	stroke-linejoin round
	stroke-linecap round

.dots
	stroke-width 5px
	stroke-linecap round
	stroke-dasharray none
</style>
