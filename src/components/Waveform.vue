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

// Audio length in seconds, refreshed on load. Reactive so the offset below
// recomputes once the duration is known.
const duration = shallowRef(0)

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
	duration.value = ws.value?.getDuration() ?? 0

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

// WaveSurfer's own scroll clamps to the audio content, so near the start/end it
// can't line the waveform up with a timeline that's longer than the audio (it
// sticks to an edge). Re-place the whole element by exactly the clamped-away
// amount so audio time `range[0]` always sits at the left edge — and once the
// view is fully past the audio, the waveform just slides off-screen.
const styles = computed(() => {
	const range = props.range
	if (!range || !duration.value) return {}

	const px = pxPerSec.value
	const maxScroll = Math.max(0, duration.value * px - width.value)
	const desiredScroll = range[0] * px
	const actualScroll = Math.max(0, Math.min(desiredScroll, maxScroll))
	const offset = actualScroll - desiredScroll

	return offset ? {transform: `translateX(${offset}px)`} : {}
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
