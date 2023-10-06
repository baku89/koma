<template>
	<Tq.InputString
		v-if="config.value === null || !config.option"
		:modelValue="config.value ? String(config.value) : '-'"
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
		:prefix="prefix"
		:suffix="suffix"
		@focus="focusing = true"
		@blur="focusing = false"
		@update:modelValue="update"
	/>
</template>

<script lang="ts" setup generic="T">
import {capital} from 'case'
import {throttle} from 'lodash'
import Tq from 'tweeq'
import {computed, ref, watch} from 'vue'

import {TethrConfig} from '@/use/useTethr'

interface Props {
	config: TethrConfig<T>
	suffix?: string
	prefix?: string
}

const props = withDefaults(defineProps<Props>(), {prefix: '', suffix: ''})

const labelizer = computed<(value: T | null) => string>(() => {
	if (props.prefix || props.suffix) {
		return (value: T | null) => props.prefix + value + props.suffix
	} else {
		return (value: T | null) => {
			return /^[a-z]$/.test(value as any)
				? capital(value as any)
				: String(value)
		}
	}
})

const targetValue = ref<any>(props.config.value)

const focusing = ref(false)

const setterDebounced = computed(() => {
	return throttle(props.config.set, 100)
})

function update(value: any) {
	targetValue.value = value
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
