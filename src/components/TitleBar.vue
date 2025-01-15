<script lang="ts" setup>
import {Icon} from '@iconify/vue'
import * as Bndr from 'bndr-js'
import * as Tq from 'tweeq'
import {computed, onUnmounted, ref} from 'vue'

import {useAuxDevicesStore} from '@/stores/auxDevices'
import {useCncStore} from '@/stores/cnc'
import {useProjectStore} from '@/stores/project'
import {useTimerStore} from '@/stores/timer'
import {useViewportStore} from '@/stores/viewport'
import {toTime} from '@/utils'

import TitleBarCameraConnection from './TitleBarCameraConnection.vue'

const viewport = useViewportStore()
const project = useProjectStore()
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
			<Tq.InputGroup>
				<Tq.InputButtonToggle
					v-model="viewport.isPlaying"
					:icon="viewport.isPlaying ? 'mdi:pause' : 'mdi:play'"
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
					@update:modelValue="viewport.setCurrentFrame"
				/>
			</Tq.InputGroup>
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
			<Tq.InputGroup>
				<Tq.InputButtonToggle
					v-model="viewport.enableOnionskin"
					v-tooltip="'Enable Onionskin'"
					icon="fluent-emoji-high-contrast:onion"
				/>
				<Tq.InputButtonToggle
					v-model="viewport.coloredOnionskin"
					label="Color"
				/>
			</Tq.InputGroup>
			<Tq.InputGroup>
				<Tq.InputButton
					v-tooltip="'Reset Timer'"
					icon="material-symbols:timer"
					@click="timer.reset"
				/>
				<Tq.InputString
					:modelValue="toTime(timer.current)"
					style="width: 5em"
					font="numeric"
					disabled
				/>
			</Tq.InputGroup>
		</template>
		<template #right>
			<TitleBarCameraConnection />
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
			<vMenu>
				<Tq.IconIndicator
					icon="game-icons:mechanical-arm"
					:active="cnc.connected"
				/>
				<template #popper>
					<p>{{ cnc.connected ? 'CNC Connected' : 'No CNC Available' }}</p>
					<pre>{{ cnc.log }}</pre>
					<Tq.InputButton label="Status" />
				</template>
			</vMenu>
		</template>
	</Tq.TitleBar>
</template>
