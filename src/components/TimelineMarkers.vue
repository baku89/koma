<script setup lang="ts">
import {Bndr} from 'bndr-js'
import {scalar} from 'linearly'
import {useBndr} from 'tweeq'
import {ref, watch} from 'vue'

import {useMarkersStore} from '@/stores/markers'
import {useProjectStore} from '@/stores/project'
import {speak} from '@/utils'

import TimelineMarker from './TimelineMarker.vue'

interface Props {
	komaWidth: number
}

const props = defineProps<Props>()

const project = useProjectStore()
const markers = useMarkersStore()

const $root = ref<null | HTMLElement>(null)

const cursorVisible = ref(false)

useBndr($root, $root => {
	const pointer = Bndr.pointer($root)

	pointer.position({coordinate: 'offset'}).on(([x, y]) => {
		const frame = Math.floor(x / props.komaWidth)
		const verticalPosition = scalar.clamp(y / $root.clientHeight, 0, 1)

		markers.cursor = {...markers.cursor, frame, verticalPosition}
	})

	pointer.primary.down().on(() => {
		if (!cursorVisible.value) return

		markers.add()
	})

	pointer.on(e => {
		if (
			e.target !== $root ||
			e.type === 'pointerleave' ||
			e.type === 'pointercancel'
		) {
			cursorVisible.value = false
		} else {
			cursorVisible.value = true
		}
	})
})

// Speak marker labels on change the capture frame
watch(
	() => project.captureShot,
	({frame}) => {
		project.markers
			.filter(
				m => m.frame <= frame && frame < m.frame + Math.max(1, m.duration)
			)
			.sort((a, b) => a.verticalPosition - b.verticalPosition)
			.forEach(m => speak(m.label))
	},
	{deep: true}
)
</script>

<template>
	<div ref="$root" class="TimelineMarkers">
		<TimelineMarker
			v-if="cursorVisible"
			class="cursor"
			:marker="markers.cursor"
		/>
		<TimelineMarker
			v-for="(marker, i) in project.markers ?? []"
			:key="i"
			:index="i"
			:marker="marker"
		/>
	</div>
</template>

<style lang="stylus" scoped>
.TimelineMarkers
	position absolute
	inset 0
	z-index 100

.cursor
	opacity .5
	pointer-events none
</style>
