<script setup lang="ts">
import {onBeforeUnmount, onMounted, ref, watch} from 'vue'
import WaveSurfer from 'wavesurfer.js'

import {useProjectStore} from '@/stores/project'

import {useTheme} from '../../dev_modules/tweeq/src/useTheme'

const project = useProjectStore()
const theme = useTheme()

const $container = ref<HTMLDivElement | null>(null)

onMounted(() => {
	if (!$container.value) return

	const ws = WaveSurfer.create({
		container: $container.value,
		hideScrollbar: true,
		minPxPerSec: 1,
		interact: false,
		barWidth: 0,
		height: 'auto',
		mediaControls: false,
		fillParent: false,
		waveColor: theme.value.colorGrayOnBackground,
		cursorWidth: 0,
	})

	// TODO: Update on the primary color has changed

	watch(
		() => [project.audio.src] as const,
		([src]) => {
			if (src) {
				ws.loadBlob(src)
			} else {
				ws.empty()
			}
		},
		{immediate: true}
	)

	ws.on('load', updateZoom)

	watch(() => [project.timeline.zoomFactor, project.fps], updateZoom, {
		immediate: true,
	})

	function updateZoom() {
		try {
			const zoom = Math.round(project.timeline.zoomFactor * 80 * project.fps)
			ws.zoom(zoom)
		} catch (e) {
			null
		}
	}

	onBeforeUnmount(ws.destroy)
})
</script>

<template>
	<div ref="$container" class="TimelineWaveform" />
</template>

<style lang="stylus" scoped>
.TimelineWaveform
	height 100%
	pointer-events none
</style>
