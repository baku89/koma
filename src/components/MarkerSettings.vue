<script lang="ts" setup>
import * as Tq from 'tweeq'
import {computed} from 'vue'

import {useTimelineStore} from '@/stores/timeline'

const timeline = useTimelineStore()

const visibleProps = computed(() => {
	switch (timeline.currentTool) {
		case 'select':
		case 'marker':
			return ['color', 'label', 'duration']
		case 'pencil':
			return ['color', 'strokeWidth']
		default:
			return []
	}
})
</script>

<template>
	<Tq.ParameterGroup label="Tool Options" name="toolOptions">
		<Tq.Parameter v-if="visibleProps.includes('color')" label="Color">
			<Tq.InputColor v-model="timeline.toolOptions.color" :alpha="false" />
		</Tq.Parameter>
		<Tq.Parameter v-if="visibleProps.includes('label')" label="Label">
			<Tq.InputString v-model="timeline.toolOptions.label" />
		</Tq.Parameter>
		<Tq.Parameter v-if="visibleProps.includes('duration')" label="Duration">
			<Tq.InputNumber
				v-model="timeline.toolOptions.duration"
				:min="0"
				:step="1"
			/>
		</Tq.Parameter>
	</Tq.ParameterGroup>
</template>

<style lang="stylus" scoped>
@import '../../dev_modules/tweeq/src/common.styl'
</style>
