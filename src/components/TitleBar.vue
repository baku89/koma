<script lang="ts" setup>
import {Icon} from '@iconify/vue'
import {Bndr} from 'bndr-js'
import prettyBytes from 'pretty-bytes'
import Tq from 'tweeq'
import {computed, onUnmounted, ref} from 'vue'

import {useAuxStore} from '@/stores/aux'
import {useBlobStore} from '@/stores/blobCache'
import {useCameraStore} from '@/stores/camera'
import {useProjectStore} from '@/stores/project'
import {useTimerStore} from '@/stores/timer'
import {useViewportStore} from '@/stores/viewport'
import {toTime} from '@/util'

const blobCache = useBlobStore()
const viewport = useViewportStore()
const project = useProjectStore()
const camera = useCameraStore()
const timer = useTimerStore()
const aux = useAuxStore()

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
			content: '<em>Saved to Disk</em>',
			html: true,
		}
	} else {
		const usage = prettyBytes(blobCache.usage)
		const quota = prettyBytes(blobCache.quota)
		const percent = Math.round((blobCache.usage / blobCache.quota) * 100) + '%'
		return {
			content: `<em>Saved to <a href="https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system">OPFS</a></em><br />${usage}/${quota} (${percent})`,
			html: true,
		}
	}
})
</script>

<template>
	<Tq.TitleBar name="Koma" class="title" icon="favicon.svg">
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
				<Tq.InputIconToggle
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
					@update:modelValue="viewport.currentFrame = $event"
				/>
			</div>
			<Tq.InputIconToggle
				v-model="project.isLooping"
				v-tooltip="'Loop'"
				icon="material-symbols:laps"
			/>
			<Tq.InputIconToggle
				v-model="viewport.enableHiRes"
				v-tooltip="'Hi-Res'"
				icon="mdi:high-definition"
			/>
			<Tq.InputIconToggle
				v-model="viewport.enableOnionskin"
				v-tooltip="'Enable Onionskin'"
				icon="fluent-emoji-high-contrast:onion"
			/>
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
		</template>
	</Tq.TitleBar>
</template>
