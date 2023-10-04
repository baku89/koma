<template>
	<Tq.InputString
		v-if="config.value === null"
		modelValue="-"
		font="monospace"
		align="center"
		disabled
	/>
	<Tq.InputString
		v-else-if="!config.option"
		:modelValue="String(targetValue)"
		font="monospace"
		align="center"
		disabled
	/>
	<Tq.InputDropdown
		v-else-if="config.option.type === 'enum'"
		:modelValue="targetValue"
		:options="config.option.values"
		:labelizer="labelizer"
		:disabled="config.writable"
		font="monospace"
		align="center"
		@focus="focusing = true"
		@blur="focusing = false"
		@update:modelValue="update"
	/>
	<Tq.InputNumber
		v-else-if="config.option?.type === 'range'"
		:modelValue="targetValue"
		:min="config.option.min"
		:max="config.option.max"
		:step="config.option.step"
		:disabled="!config.writable"
		@focus="focusing = true"
		@blur="focusing = false"
		@update:modelValue="update"
	/>
</template>

<script lang="ts" setup generic="T">
import {capital} from 'case'
import {throttle} from 'lodash'
import {ConfigName} from 'tethr'
import Tq from 'tweeq'
import {computed, ref, watch} from 'vue'

import {TethrConfig} from '@/use/useTethr'

interface Props {
	name?: ConfigName
	config: TethrConfig<T>
	unit?: string
}

const labelizer = computed<(value: T | null) => string>(() => {
	if (props.name === 'aperture') {
		return (value: T | null) => 'F' + value
	} else if (props.name === 'focalLength') {
		return (value: T | null) => value + ' mm'
	} else if (props.name === 'colorTemperature') {
		return (value: T | null) => value + ' K'
	} else {
		return (value: T | null) => {
			return /^[a-z]$/.test(value as any)
				? capital(value as any)
				: String(value)
		}
	}
})

const props = withDefaults(defineProps<Props>(), {unit: ''})

const targetValue = ref(props.config.value)

const focusing = ref(false)

const setterDebounced = computed(() => {
	return throttle(props.config.set, 100)
})

function update(value: T) {
	targetValue.value = value as any
	setterDebounced.value(value)
}

watch(
	() => [props.config.value, focusing.value] as const,
	([value, focusing]) => {
		if (!focusing) targetValue.value = value as any
	}
)
</script>

<style lang="stylus" scoped>
.TethrConfig
	display grid
	grid-column 1 / 3
	grid-template-columns subgrid
</style>
