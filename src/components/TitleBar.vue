<script lang="ts" setup>
import {Icon} from '@iconify/vue'
import * as Bndr from 'bndr-js'
import * as Tq from 'tweeq'
import {computed, onUnmounted, ref} from 'vue'

import {useAuxDevicesStore} from '@/stores/auxDevices'
import {useCameraStore} from '@/stores/camera'
import {useCncStore} from '@/stores/cnc'
import {useProjectStore} from '@/stores/project'
import {useTimerStore} from '@/stores/timer'
import {useViewportStore} from '@/stores/viewport'
import {toTime} from '@/utils'

const viewport = useViewportStore()
const project = useProjectStore()
const camera = useCameraStore()
const timer = useTimerStore()
const aux = useAuxDevicesStore()
const cnc = useCncStore()

const gamepads = ref<string[]>([])

const destroyBndr = Bndr.createScope(() => {
	Bndr.gamepad()
		.devices()
		.on(gs => {
			gamepads.value = gs.map(g => g.id)
		})
})

onUnmounted(destroyBndr)

const destinationInfo = computed(() => {
	if (project.isSavedToDisk) {
		return {
			content: 'Saved to Disk',
			html: true,
		}
	} else {
		return {
			content: `Saved to App`,
			html: true,
		}
	}
})
</script>

<template>
	<Tq.TitleBar name="Koma" icon="favicon.svg">
		<template #left>
			<Tq.InputString v-model="project.name" style="width: 8em" />
			<Tq.IconIndicator
				v-tooltip="destinationInfo"
				:icon="
					project.isSavedToDisk ? 'clarity:hard-disk-solid' : 'octicon:cache-16'
				"
			/>
			<Icon
				v-show="project.isSaving || project.isOpening"
				icon="eos-icons:bubble-loading"
			/>
		</template>
		<template #center>
			<div style="display: flex">
				<Tq.InputButtonToggle
					v-model="viewport.isPlaying"
					:icon="viewport.isPlaying ? 'mdi:pause' : 'mdi:play'"
					horizontalPosition="left"
				/>
				<Tq.InputNumber
					:modelValue="viewport.previewFrame"
					:precision="0"
					:min="0"
					:max="project.allKomas.length - 1"
					:step="1"
					:bar="false"
					suffix=" F"
					style="width: 5em"
					horizontalPosition="right"
					@update:modelValue="viewport.setCurrentFrame"
				/>
			</div>
			<Tq.InputButtonToggle
				v-model="project.isLooping"
				v-tooltip="'Loop'"
				icon="material-symbols:laps"
			/>
			<Tq.InputButtonToggle
				v-model="viewport.enableHiRes"
				v-tooltip="'Hi-Res'"
				icon="mdi:high-definition"
			/>
			<div style="display: flex">
				<Tq.InputButtonToggle
					v-model="viewport.enableOnionskin"
					v-tooltip="'Enable Onionskin'"
					icon="fluent-emoji-high-contrast:onion"
					horizontalPosition="left"
				/>
				<Tq.InputButtonToggle
					v-model="viewport.coloredOnionskin"
					label="Color"
					horizontalPosition="right"
				/>
			</div>
			<div style="display: flex">
				<Tq.InputButton
					v-tooltip="'Reset Timer'"
					icon="material-symbols:timer"
					horizontalPosition="left"
					@click="timer.reset"
				/>
				<Tq.InputString
					:modelValue="toTime(timer.current)"
					style="width: 5em"
					horizontalPosition="right"
					font="numeric"
					disabled
				/>
			</div>
		</template>
		<template #right>
			<Tq.InputButton
				:icon="camera.tethr ? 'mdi:camera' : 'mdi:connection'"
				:label="camera.model.value ?? 'Connect'"
				@click="camera.toggleConnection"
			/>
			<Tq.IconIndicator
				v-tooltip="{
					content:
						gamepads.length > 0
							? gamepads.join('<br />')
							: 'No Gamepad Connected',
					html: true,
				}"
				:active="gamepads.length > 0"
				icon="solar:gamepad-bold"
			/>
			<Tq.IconIndicator
				v-tooltip="
					aux.tracker.enabled ? 'Tracker Connected' : 'No Tracker Available'
				"
				icon="tabler:gizmo"
				:active="aux.tracker.enabled"
			/>
			<vTooltip>
				<Tq.IconIndicator
					icon="game-icons:mechanical-arm"
					:active="cnc.connected"
				/>
				<template #popper>
					<p>{{ cnc.connected ? 'CNC Connected' : 'No CNC Available' }}</p>
					<pre>{{ cnc.log }}</pre>
					<Tq.InputButton label="Status" />
				</template>
			</vTooltip>
		</template>
	</Tq.TitleBar>
</template>
