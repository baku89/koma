<script lang="ts" setup>
import {Icon} from '@iconify/vue'
import {ConfigName} from 'tethr'
import Tq, {useAppConfigStore, useThemeStore} from 'tweeq'

import {useCameraStore} from '@/stores/camera'
import {useProjectStore} from '@/stores/project'

import TethrConfig from './TethrConfig.vue'

const camera = useCameraStore()
const project = useProjectStore()
const theme = useThemeStore()
const appConfig = useAppConfigStore()

const showAll = appConfig.ref('cameraControl.showAll', true)

const configNames: ConfigName[] = [
	'exposureMode',
	'exposureComp',
	'focalLength',
	'focusDistance',
	'aperture',
	'shutterSpeed',
	'whiteBalance',
	'colorTemperature',
	'iso',
	'imageQuality',
	'shutterSound',
	'colorMode',
]

const configLabels = {
	exposureMode: {label: 'Mode', icon: 'material-symbols:settings-photo-camera'},
	exposureComp: {label: 'Exp.', icon: 'material-symbols:exposure'},
	focalLength: {label: 'F.L.', icon: 'lucide:focus'},
	focusDistance: {label: 'F.D.', icon: 'tabler:frustum'},
	aperture: {label: 'Apr.', icon: 'ph:aperture'},
	shutterSpeed: {label: 'SS', icon: 'material-symbols:shutter-speed'},
	whiteBalance: {label: 'WB', icon: 'subway:black-white'},
	colorTemperature: {label: 'C.Temp.', icon: 'mdi:temperature'},
	iso: {label: 'ISO', icon: 'carbon:iso'},
	imageQuality: {label: 'Quality', icon: 'mdi:image'},
	shutterSound: {label: 'Vol.', icon: 'ic:baseline-volume-up'},
	colorMode: {label: 'Color', icon: 'mdi:palette'},
} as Record<ConfigName, {label: string; icon: string}>

function getConfigVisibility(name: ConfigName) {
	return project.visibleProperties[name]?.visible ?? false
}

function toggleConfigVisibility(name: ConfigName) {
	project.$patch({
		visibleProperties: {
			[name]: {visible: !(project.visibleProperties[name]?.visible ?? false)},
		},
	})
}

function getConfigColor(name: ConfigName) {
	return project.visibleProperties[name]?.color ?? theme.colorGrayOnBackground
}

function setConfigColor(name: ConfigName, value: string) {
	project.$patch({
		visibleProperties: {
			[name]: {color: value},
		},
	})
}
</script>

<template>
	<Tq.ParameterGroup name="cameraControl" label="Camera Control">
		<template #headingRight>
			<button class="show-all-button" @click="showAll = !showAll">
				{{ showAll ? 'Collapse' : 'Show All' }}
			</button>
		</template>

		<template v-for="name in configNames">
			<Tq.Parameter
				v-if="showAll || getConfigVisibility(name)"
				:key="name"
				:label="configLabels[name].label"
			>
				<template #label>
					<Icon
						v-if="showAll"
						class="visibility"
						:icon="getConfigVisibility(name) ? 'mdi:eye' : 'mdi:eye-closed'"
						@click="toggleConfigVisibility(name)"
					/>
					<Tq.InputColor
						class="color"
						:modelValue="getConfigColor(name)"
						@update:modelValue="setConfigColor(name, $event)"
					>
						<Icon
							:icon="configLabels[name].icon"
							:style="{color: getConfigColor(name)}"
						/>
					</Tq.InputColor>
					{{ configLabels[name].label }}
				</template>
				<TethrConfig :config="(camera as any)[name]" :name="name" />
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
		color var(--tq-color-on-background)

.color .iconify
	hover-transition(background)
	background transparent
	border-radius var(--tq-input-border-radius)

	&:hover
		background var(--tq-color-input-hover)
</style>
