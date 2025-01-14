<script lang="ts" setup generic="T">
import {capital} from 'case'
import {scalar} from 'linearly'
import {ConfigName, WhiteBalance} from 'tethr'
import * as Tq from 'tweeq'
import {computed, ref} from 'vue'

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

const focusing = ref(false)

function update(value: any) {
	props.config.set(value)
}

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

const canIncrement = computed(() => {
	if (!props.config.writable) return false
	return true
})

function increment(dir: 1 | -1) {
	if (!props.config.writable) return

	const {option, value} = props.config

	if (!option || value === null) return

	if (option.type === 'range') {
		if (
			typeof option.min !== 'number' ||
			typeof option.max !== 'number' ||
			typeof option.step !== 'number'
		) {
			return
		}

		const step = option.step || ((option.max - option.min) / 100) * dir

		if (typeof value !== 'number') return

		update(scalar.clamp(value + step, option.min, option.max))
	} else if (option.type === 'enum') {
		const values = option.values as string[]

		const index = values.indexOf(value as any)

		if (index === -1) return

		const nextIndex = scalar.clamp(index + dir, 0, values.length - 1)

		update(values[nextIndex])
	}
}
</script>

<template>
	<div class="TethrConfig">
		<Tq.InputButton
			v-if="canIncrement"
			icon="ic:round-minus"
			@click="increment(-1)"
			gray
			horizontalPosition="left"
		/>
		<Tq.InputString
			v-if="config.value === null || !config.option"
			:modelValue="config.value ? String(config.value) : '-'"
			align="center"
			disabled
		/>
		<Tq.InputDropdown
			v-else-if="config.option.type === 'enum'"
			:modelValue="config.value"
			:options="config.option.values"
			:disabled="config.writable"
			align="center"
			v-bind="inputAttrs"
			@focus="focusing = true"
			@blur="focusing = false"
			@update:modelValue="update"
		/>
		<Tq.InputNumber
			v-else-if="
				typeof config.value === 'number' && config.option?.type === 'range'
			"
			:modelValue="config.value"
			:min="config.option.min as number"
			:max="config.option.max as number"
			:step="config.option.step as number"
			:disabled="!config.writable"
			:prefix="prefix"
			:suffix="suffix"
			v-bind="inputAttrs"
			@focus="focusing = true"
			@blur="focusing = false"
			@update:modelValue="update"
		/>
		<Tq.InputButton
			v-if="canIncrement"
			gray
			icon="ic:round-plus"
			@click="increment(1)"
			horizontalPosition="right"
		/>
	</div>
</template>

<style lang="stylus" scoped>
.TethrConfig
	display flex
</style>
