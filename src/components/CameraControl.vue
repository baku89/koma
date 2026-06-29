<script lang="ts" setup>
import {ConfigName} from 'tethr'
import {useTweeq} from 'tweeq'
import {computed} from 'vue'

import {useCameraStore} from '@/stores/camera'
import {useProjectStore} from '@/stores/project'

import TethrConfig from './TethrConfig.vue'

const Tq = useTweeq()
const camera = useCameraStore()
const project = useProjectStore()

const showAll = Tq.config.ref('cameraControl.showAll', true)

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
	'destinationToSave',
	'imageAspect',
	'autoFocusFrameSize',
	'focusMeteringMode',
	'focusPeaking',
	'liveviewMagnifyRatio',
]

const configLabels = {
	exposureMode: {
		label: 'Mode',
		icon: 'material-symbols:settings-photo-camera',
		hint: 'Exposure mode (P / A / S / M)',
	},
	exposureComp: {
		label: 'Exp.',
		icon: 'material-symbols:exposure',
		hint: 'Exposure compensation',
	},
	focalLength: {label: 'F.L.', icon: 'lucide:focus', hint: 'Focal length'},
	focusDistance: {label: 'F.D.', icon: 'tabler:frustum', hint: 'Focus distance'},
	aperture: {label: 'Apr.', icon: 'ph:aperture', hint: 'Aperture'},
	shutterSpeed: {
		label: 'SS',
		icon: 'material-symbols:shutter-speed',
		hint: 'Shutter speed',
	},
	whiteBalance: {label: 'WB', icon: 'subway:black-white', hint: 'White balance'},
	colorTemperature: {
		label: 'C.Temp.',
		icon: 'mdi:temperature',
		hint: 'Color temperature',
	},
	iso: {label: 'ISO', icon: 'carbon:iso', hint: 'ISO sensitivity'},
	imageQuality: {label: 'Quality', icon: 'mdi:image', hint: 'Image quality'},
	shutterSound: {
		label: 'Vol.',
		icon: 'ic:baseline-volume-up',
		hint: 'Shutter sound volume',
	},
	colorMode: {label: 'Color', icon: 'mdi:palette', hint: 'Color mode'},
	destinationToSave: {
		label: 'Save',
		icon: 'mdi:content-save',
		hint: 'Destination to save captures',
	},
	imageAspect: {
		label: 'Aspect',
		icon: 'mdi:aspect-ratio',
		hint: 'Image aspect ratio',
	},
	autoFocusFrameSize: {
		label: 'AF Size',
		icon: 'mdi:camera-metering-matrix',
		hint: 'Autofocus frame size',
	},
	focusMeteringMode: {
		label: 'Metering',
		icon: 'mdi:camera-metering-matrix',
		hint: 'Focus metering mode',
	},
	focusPeaking: {
		label: 'Peaking',
		icon: 'material-symbols:center-focus-strong',
		hint: 'Focus peaking',
	},
	liveviewMagnifyRatio: {
		label: 'LV Zoom',
		icon: 'material-symbols:zoom-in',
		hint: 'Live view magnification',
	},
} as Record<ConfigName, {label: string; icon: string; hint?: string}>

const isConnected = computed(() => !!camera.tethr)

// A config the connected camera can neither read nor write (no value, not
// writable, no option) isn't worth a row — this is what trims the list right
// down for a webcam. While disconnected we keep showing everything (there's no
// camera to declare anything unsupported).
function isConfigSupported(name: ConfigName) {
	if (!isConnected.value) return true
	const config = (camera as any)[name] as
		| {writable?: boolean; value?: unknown; option?: unknown}
		| undefined
	if (!config) return false
	return !!config.writable || config.value !== null || config.option != null
}

// Whether the camera exposes anything the user can actually change. When it
// doesn't (disconnected, or e.g. a bare webcam), we swap the parameter list for
// a short message instead of an empty grid.
const hasWritableConfig = computed(() =>
	configNames.some(name => {
		const config = (camera as any)[name] as {writable?: boolean} | undefined
		return !!config?.writable
	})
)

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
	return project.visibleProperties[name]?.color ?? Tq.theme.colorTextMute
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
		<template v-if="hasWritableConfig" #headingRight>
			<button class="show-all-button" @click="showAll = !showAll">
				{{ showAll ? 'Collapse' : 'Show All' }}
			</button>
		</template>

		<template v-if="hasWritableConfig">
			<template v-for="name in configNames">
				<Tq.Parameter
					v-if="isConfigSupported(name) && (showAll || getConfigVisibility(name))"
					:key="name"
					:label="configLabels[name].label"
					:hint="configLabels[name].hint"
				>
					<template #label>
						<Tq.Icon
							v-if="showAll"
							class="visibility"
							:icon="getConfigVisibility(name) ? 'mdi:eye' : 'mdi:eye-closed'"
							@click="toggleConfigVisibility(name)"
						/>
						<Tq.InputColorPad
							class="color"
							:modelValue="getConfigColor(name)"
							@update:modelValue="setConfigColor(name, $event)"
						>
							<Tq.Icon
								:icon="configLabels[name].icon"
								:style="{color: getConfigColor(name)}"
							/>
						</Tq.InputColorPad>
						{{ configLabels[name].label }}
					</template>
					<TethrConfig :config="(camera as any)[name]" :name="name" />
				</Tq.Parameter>
			</template>
		</template>

		<!-- Nothing adjustable: prompt to connect (disconnected) or just explain. -->
		<div v-else class="empty-state">
			<p class="empty-message">
				{{
					isConnected
						? 'This camera has no adjustable settings.'
						: 'No camera is connected.'
				}}
			</p>
			<Tq.InputButton
				v-if="!isConnected"
				label="Connect to Camera"
				icon="mdi:camera-plus"
				data-camera-connect
				@click="camera.promptConnect()"
			/>
		</div>
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

// Span both columns but nudge in a notch so it reads as nested under the group
// without picking up the full (60px-min) label-column indent.
.empty-state
	grid-column 1 / 3
	display flex
	flex-direction column
	align-items flex-start
	gap var(--tq-gap-control)
	padding var(--tq-gap-control) 0 var(--tq-gap-control) var(--tq-gap-section)

.empty-message
	color var(--tq-color-text-mute)

// Without a cap the connect button keeps its content width (align-items
// flex-start) and overflows the column on a narrow panel. Cap it to the cell so
// the label clips to an ellipsis (+ tooltip) instead.
.empty-state :deep(.TqInputButton)
	max-width 100%

.visibility
	width var(--tq-icon-size)
	height var(--tq-icon-size)
	margin-right var(--tq-gap-group)
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
