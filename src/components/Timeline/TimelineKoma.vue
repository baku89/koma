<script lang="ts" setup>
import {computed} from 'vue'

import {useProjectStore} from '@/stores/project'

import TimelineShot from './TimelineShot.vue'

const project = useProjectStore()

interface Props {
	frame: number
}

const props = defineProps<Props>()

// One cell per row of the timeline: the shown layers, plus the capture layer
// even when hidden (dimmed, as is everything but the capture layer while solo
// is on). Layers are created in the Layers dialog (or by "New Test Shot…"),
// never by clicking below a frame.
const layerIndices = computed(() => project.timelineLayerIndices)
</script>

<template>
	<div class="Koma">
		<TimelineShot
			v-for="layer in layerIndices"
			:key="layer"
			:frame="props.frame"
			:layer="layer"
			:class="{'layer-hidden': !project.isLayerShown(layer)}"
		/>
	</div>
</template>

<style scoped lang="stylus">
.layer-hidden
	opacity 0.35
</style>
