<script lang="ts" setup>
import Tq from 'tweeq'

import {useMarkersStore} from '@/stores/markers'

const markers = useMarkersStore()
</script>

<template>
	<Tq.ParameterGroup label="Marker Settings" name="markerSettings">
		<Tq.Parameter label="Label">
			<Tq.InputString v-model="markers.cursor.label" />
		</Tq.Parameter>
		<Tq.Parameter label="Color">
			<Tq.InputColor v-model="markers.cursor.color" />
		</Tq.Parameter>
		<Tq.Parameter label="Duration">
			<Tq.InputNumber v-model="markers.cursor.duration" :min="0" :step="1" />
		</Tq.Parameter>
	</Tq.ParameterGroup>
</template>

<style lang="stylus" scoped>
@import '../../dev_modules/tweeq/src/common.styl'
</style>
