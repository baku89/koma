<script lang="ts" setup>
import {range} from 'lodash'
import {computed} from 'vue'

import {useProjectStore} from '@/stores/project'

import Shot from './Shot.vue'

const project = useProjectStore()

interface Props {
	frame: number
}

const props = defineProps<Props>()

const layerIndices = computed(() =>
	range(Math.max(1, project.layerCount(props.frame)))
)
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
