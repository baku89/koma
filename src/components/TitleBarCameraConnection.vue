<script setup lang="ts">
import * as Tq from 'tweeq'
import {computed, ref, watch} from 'vue'

import {useCameraStore} from '@/stores/camera'

const camera = useCameraStore()

const trigger = ref<HTMLElement>()
const open = ref(false)

// Native popover light-dismiss closes on an outside pointerdown — including one
// that lands on the trigger. The trigger's own click would then reopen it, so
// swallow a click that arrives right after a dismiss.
let lastDismissAt = 0

function onTriggerClick() {
	if (performance.now() - lastDismissAt < 200) return
	open.value = !open.value
}

function onUpdateOpen(value: boolean) {
	if (!value) lastDismissAt = performance.now()
	open.value = value
}

// The Tweeq title bar is an Electron drag region; the OS swallows background
// pointer events there, so a popper's light-dismiss only fires while the bar is
// `no-drag`. The bar turns off dragging when something inside it has focus, so
// focus the trigger when the popup opens (popup buttons use mousedown.prevent,
// so focus stays here while it's open).
watch(open, isOpen => {
	if (isOpen) trigger.value?.focus()
})

const label = computed(() => {
	if (camera.isConnecting) return 'Connecting…'
	return camera.tethr?.name ?? 'Not connected'
})

const icon = computed(() => {
	if (camera.isConnecting) return 'eos-icons:bubble-loading'
	if (!camera.tethr) return 'mdi:camera-off'
	return cameraIcon(camera.tethr.type)
})

function cameraIcon(type: string) {
	return type === 'ptpusb' ? 'mdi:camera' : 'mdi:webcam'
}
</script>

<template>
	<button ref="trigger" class="trigger" @click="onTriggerClick">
		<Tq.Icon class="trigger-icon" :icon="icon" />
		<span class="trigger-label">{{ label }}</span>
		<Tq.Icon class="trigger-chevron" icon="mdi:chevron-down" />
	</button>

	<Tq.Popover
		:reference="trigger ?? null"
		:open="open"
		placement="bottom-start"
		arrow
		@update:open="onUpdateOpen"
	>
		<div class="camera-menu">
			<div v-if="camera.pairedCameras.length === 0" class="empty">
				No cameras available
			</div>

			<div v-else class="cameras">
				<template v-for="(cam, i) in camera.pairedCameras" :key="i">
					<Tq.Icon class="row-icon" :icon="cameraIcon(cam.type)" />
					<span class="row-name">{{ cam.name }}</span>
					<Tq.InputButton
						v-if="camera.tethr === cam"
						icon="mdi:link-off"
						tooltip="Disconnect"
						subtle
						@click="camera.disconnect()"
					/>
					<Tq.InputButton
						v-else
						icon="mdi:link"
						tooltip="Connect"
						:disabled="camera.isConnecting"
						@click="camera.connectCamera(cam)"
					/>
				</template>
			</div>

			<hr class="divider" />

			<div class="grant">
				<Tq.InputButton
					label="PTP/USB"
					icon="mdi:camera-plus"
					subtle
					:disabled="camera.isConnecting"
					@click="camera.grant('ptpusb')"
				/>
				<Tq.InputButton
					label="Webcam"
					icon="mdi:webcam"
					subtle
					:disabled="camera.isConnecting"
					@click="camera.grant('webcam')"
				/>
			</div>
		</div>
	</Tq.Popover>
</template>

<style scoped lang="stylus">
.trigger
	height var(--tq-input-height)
	min-width 12em
	border-radius var(--tq-radius-input)
	background var(--tq-color-input)
	color var(--tq-color-text)
	display flex
	align-items center
	gap .3em
	padding 0 .5em
	cursor pointer

.trigger-icon
	flex none

.trigger-label
	flex 1
	text-align left
	overflow hidden
	text-overflow ellipsis
	white-space nowrap

.trigger-chevron
	flex none
	margin-left auto
	opacity .6

// Chrome (surface, border, blur, shadow, padding) comes from the Popover's
// Balloon now; the menu only lays out its rows.
.camera-menu
	display flex
	flex-direction column
	gap .5em
	min-width 14em

.empty
	padding .3em
	color var(--tq-color-text-mute)

.cameras
	display grid
	grid-template-columns auto 1fr auto
	gap .4em
	align-items center

.row-icon
	flex none

.row-name
	min-width 0
	overflow hidden
	text-overflow ellipsis
	white-space nowrap

.divider
	width 100%
	margin 0
	border none
	border-top 1px solid var(--tq-color-border)

.grant
	display grid
	grid-template-columns 1fr 1fr
	gap .4em
</style>
