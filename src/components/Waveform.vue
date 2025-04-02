<script setup lang="ts">
import {useElementSize} from '@vueuse/core'
import {vec2} from 'linearly'
import {useTweeq} from 'tweeq'
import {computed, onBeforeUnmount, shallowRef, watch, watchEffect} from 'vue'
import WaveSurfer from 'wavesurfer.js'

const props = defineProps<{
	src?: Blob
	/**
	 * The range of the waveform to display in seconds.
	 */
	range?: vec2
}>()

const Tq = useTweeq()

const $root = shallowRef<HTMLDivElement | null>(null)

const {width, height} = useElementSize($root)

const ws = shallowRef<WaveSurfer | null>(null)

watch(
	() => [$root.value, height.value] as const,
	([container]) => {
		if (!container) return

		if (ws.value) ws.value.destroy()

		ws.value = WaveSurfer.create({
			container,
			hideScrollbar: true,
			minPxPerSec: 1,
			interact: false,
			height: 'auto',
			mediaControls: false,
			waveColor: Tq.theme.colorTextSubtle,
		})

		if (props.src) {
			ws.value.loadBlob(props.src)
		}

		ws.value.on('ready', updateZoom)
	}
)

// Reload audio
watchEffect(() => {
	if (props.src) {
		ws.value?.loadBlob(props.src)
	} else {
		ws.value?.empty()
	}
})

// Update zoom
const pxPerSec = computed(() => {
	const _ws = ws.value

	const duration = props.range
		? props.range[1] - props.range[0]
		: (_ws?.getDuration() ?? 1)

	return Math.round(width.value / duration)
})

watch(pxPerSec, (zoom, prevZoom) => {
	if (zoom !== prevZoom) {
		setZoom(zoom)
	}
})

watch(
	() => props.range,
	range => {
		if (range) {
			ws.value?.setScrollTime(range[0])
		}
	}
)

function updateZoom() {
	const time = props.range?.[0] ?? 0
	const zoom = pxPerSec.value

	ws.value?.setScrollTime(time)
	setZoom(zoom)
}

function setZoom(zoom: number) {
	try {
		ws.value?.zoom(zoom)
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
	} catch (e) {
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		null
	}
}

const styles = computed(() => {
	if (!props.range) return {}

	const [start] = props.range

	if (start < 0) {
		return {
			transform: `translateX(${Math.abs(start) * pxPerSec.value}px)`,
		}
	} else {
		// TODO: Implement for the case when the end exceeds the duration
		return {}
	}
})

onBeforeUnmount(() => ws.value?.destroy())
</script>

<template>
	<div ref="$root" class="Waveform" :style="styles" />
</template>

<style lang="stylus" scoped>
.Waveform
	position relative
	height 100%
	opacity 0.2
</style>
