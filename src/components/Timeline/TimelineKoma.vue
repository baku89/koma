<script lang="ts" setup>
import {computed} from 'vue'

import {useProjectStore} from '@/stores/project'

import TimelineShot from './TimelineShot.vue'

const project = useProjectStore()

interface Props {
	frame: number
}

const props = defineProps<Props>()

// One cell per *visible* layer, in display order. Layers are created in the
// Layers dialog (or by "New Test Shot…"), never by clicking below a frame.
const layerIndices = computed(() => project.visibleLayerIndices)
</script>

<template>
	<div class="Koma">
		<TimelineShot
			v-for="layer in layerIndices"
			:key="layer"
			:frame="props.frame"
			:layer="layer"
		/>
	</div>
</template>
