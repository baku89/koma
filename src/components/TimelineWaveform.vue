<script setup lang="ts">
import {debouncedWatch, useElementSize} from '@vueuse/core'
import {useThemeStore} from 'tweeq'
import {onBeforeUnmount, ref, watch} from 'vue'
import WaveSurfer from 'wavesurfer.js'

import {useProjectStore} from '@/stores/project'

const project = useProjectStore()
const theme = useThemeStore()

const $container = ref<HTMLDivElement | null>(null)

const {height} = useElementSize($container)

let ws: WaveSurfer | undefined

debouncedWatch(
	() => [height.value, $container.value] as const,
	([height, container]) => {
		if (!container) return

		if (ws) ws.destroy()

		ws = WaveSurfer.create({
			container,
			hideScrollbar: true,
			minPxPerSec: 1,
			interact: false,
			barWidth: 0,
			height,
			mediaControls: false,
			fillParent: false,
			waveColor: theme.colorGrayOnBackground,
			cursorWidth: 0,
		})

		if (project.audio.src) {
			ws.loadBlob(project.audio.src)
		}

		ws.on('ready', () => updateZoom())
	},
	{debounce: 200}
)

// TODO: Update on the primary color has changed
watch(
	() => [project.audio.src] as const,
	([src]) => {
		if (src) {
			ws?.loadBlob(src)
		} else {
			ws?.empty()
		}
	}
)

watch(() => [project.timeline.zoomFactor, project.fps], updateZoom, {
	immediate: true,
})

function updateZoom() {
	try {
		const zoom = Math.round(project.timeline.zoomFactor * 80 * project.fps)
		ws?.zoom(zoom)
	} catch (e) {
		return null
	}
}

onBeforeUnmount(() => ws?.destroy())
</script>

<template>
	<div ref="$container" class="TimelineWaveform" />
</template>

<style lang="stylus" scoped>
.TimelineWaveform
	position relative
	height 100%
	pointer-events none
</style>
