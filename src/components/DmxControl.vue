<script setup lang="ts">
import {useTweeq} from 'tweeq'

import {useDmxStore} from '@/stores/dmx'
import {useProjectStore} from '@/stores/project'

const Tq = useTweeq()
const project = useProjectStore()
const dmx = useDmxStore()
const showAll = Tq.config.ref('dmxControl.showAll', true)

function getVisibility(index: number) {
	const name = `dmx${index + 1}`
	return project.visibleProperties[name]?.visible ?? false
}

function toggleVisibility(index: number) {
	const name = `dmx${index + 1}`

	project.$patch({
		visibleProperties: {
			[name]: {visible: !(project.visibleProperties[name]?.visible ?? false)},
		},
	})
}

function getColor(index: number) {
	return project.visibleProperties[`dmx${index + 1}`]?.color ?? 'white'
}

function setColor(index: number, color: string) {
	project.$patch({
		visibleProperties: {
			[`dmx${index + 1}`]: {color},
		},
	})
}
</script>

<template>
	<Tq.ParameterGroup name="dmxControl" label="DMX Control">
		<template #headingRight>
			<button class="show-all-button" @click="showAll = !showAll">
				{{ showAll ? 'Collapse' : 'Show All' }}
			</button>
		</template>
		<template v-for="(v, i) in dmx.values">
			<Tq.Parameter
				v-if="showAll || getVisibility(i)"
				:key="i"
				:label="'#' + (i + 1)"
			>
				<template #label>
					<Tq.Icon
						v-if="showAll"
						class="visibility"
						:icon="getVisibility(i) ? 'mdi:eye' : 'mdi:eye-closed'"
						@click="toggleVisibility(i)"
					/>
					<Tq.InputColorPad
						class="color"
						:modelValue="getColor(i)"
						@update:modelValue="setColor(i, $event)"
						tabindex="-1"
					>
						<Tq.Icon
							icon="material-symbols:fluorescent"
							:style="{color: getColor(i)}"
						/>
					</Tq.InputColorPad>
					{{ '#' + (i + 1) }}
				</template>
				<Tq.InputNumber v-model="v.value" :min="0" :max="1" />
			</Tq.Parameter>
		</template>
	</Tq.ParameterGroup>
</template>

<style lang="stylus" scoped>
@import '../../dev_modules/tweeq/src/common.styl'

.show-all-button
	background var(--tq-color-input)
	height var(--tq-input-height)
	padding 0 1em
	border-radius 9999px
	hover-transition(background)

	&:hover
		background var(--tq-color-input-hover)

.visibility
	width 16px
	height 16px
	margin-right 2px
	hover-transition(color)

	&:hover
		color var(--tq-color-text)

.color .iconify
	hover-transition(background)
	background transparent
	border-radius var(--tq-radius-input)

	&:hover
		background var(--tq-color-input-hover)
</style>
