<script lang="ts" setup>
import {computed} from 'vue'

import {useProjectStore} from '@/stores/project'

import Shot from './Shot.vue'

const project = useProjectStore()

interface Props {
	frame: number
}

const props = defineProps<Props>()

const layerIndices = computed(() => {
	const count = project.allKomas[props.frame]?.shots.length ?? 0
	return Array(count + 1)
		.fill(0)
		.map((_, i) => i)
})
</script>

<template>
	<div class="Koma">
		<Shot
			v-for="layer in layerIndices"
			:key="layer"
			:frame="props.frame"
			:layer="layer"
		/>
	</div>
</template>
