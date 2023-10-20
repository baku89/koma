<script lang="ts" setup generic="T">
import {capital} from 'case'
import {throttle} from 'lodash'
import {ConfigName, WhiteBalance} from 'tethr'
import Tq from 'tweeq'
import {computed, ref, watch} from 'vue'

import {Config} from '@/stores/camera'

interface Props {
	config: Config<T>
	name?: ConfigName
	suffix?: string
	prefix?: string
}

interface InputAttrs {
	labelizer?: (value: T | null) => string
	leftIcon?: string
	rightIcon?: string
	icons?: string[]
	prefix?: string
	suffix?: string
}

const props = withDefaults(defineProps<Props>(), {prefix: '', suffix: ''})

const targetValue = ref<any>(props.config.value)

const focusing = ref(false)

const setterDebounced = computed(() => {
	return throttle(props.config.set, 50)
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

const inputAttrs = computed<InputAttrs>(() => {
	switch (props.name) {
		case 'aperture':
			return {
				labelizer: v => 'F' + v,
			}
		case 'focalLength':
			return {
				suffix: 'mm',
			}
		case 'focusDistance':
			return {
				leftIcon: 'tabler:macro',
				rightIcon: 'material-symbols:landscape-outline',
			}
		case 'whiteBalance': {
			const values =
				props.config.option?.type === 'enum'
					? (props.config.option.values as string[])
					: []

			const icons = values.map(
				value => whiteBalanceIcons.get(value as WhiteBalance) ?? ''
			)

			return {
				icons,
			}
		}
		case 'colorTemperature':
			return {
				suffix: 'K',
			}
		case 'shutterSpeed':
			return {
				labelizer: (v: any) => (/^[a-z]+$/i.test(v) ? capital(v) : v),
			}
	}

	return {}
})

const whiteBalanceIcons = new Map<WhiteBalance, string>([
	['auto', 'material-symbols:wb-auto'],
	['auto cool', 'material-symbols:wb-auto-outline'],
	['auto warm', 'material-symbols:wb-auto-outline'],
	['auto ambience', 'material-symbols:wb-auto-outline'],
	['daylight', 'material-symbols:wb-sunny'],
	['shade', 'material-symbols:wb-shade'],
	['cloud', 'material-mid:wb-cloudy'],
	['incandescent', 'material-symbols:wb-incandescent'],
	['fluorescent', 'material-symbols:fluorescent'],
	['tungsten', 'ic:baseline-tungsten'],
	['flash', 'mdi:flash'],
	['underwater', 'material-symbols:water'],
	['manual', 'mdi:temperature-kelvin'],
	['custom', 'material-symbols:settings'],
])
</script>

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
		:disabled="config.writable"
		font="monospace"
		align="center"
		v-bind="inputAttrs"
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
		v-bind="inputAttrs"
		@focus="focusing = true"
		@blur="focusing = false"
		@update:modelValue="update"
	/>
</template>

<style lang="stylus" scoped>
.TethrConfig
	display grid
	grid-column 1 / 3
	grid-template-columns subgrid
</style>
