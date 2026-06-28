<script setup lang="ts">
import {useEventListener} from '@vueuse/core'
import * as Tq from 'tweeq'
import {computed, onBeforeUnmount, onMounted, ref, watch} from 'vue'

import {useCameraStore} from '@/stores/camera'

const camera = useCameraStore()

const trigger = ref<HTMLElement>()
const menu = ref<HTMLElement>()
const open = ref(false)

// Whether the machine has any webcam at all. enumerateDevices() lists
// `videoinput` entries even before permission is granted (labels are empty, but
// the count is accurate), so we can gray out the Webcam button when there's
// none to connect to. devicechange keeps it live across plug/unplug.
const hasWebcam = ref(true)

async function refreshWebcam() {
	try {
		const devices = await navigator.mediaDevices.enumerateDevices()
		hasWebcam.value = devices.some(d => d.kind === 'videoinput')
	} catch {
		// If we can't enumerate, don't lock the user out — leave it enabled.
		hasWebcam.value = true
	}
}

onMounted(() => {
	refreshWebcam()
	navigator.mediaDevices.addEventListener('devicechange', refreshWebcam)
})

onBeforeUnmount(() => {
	navigator.mediaDevices.removeEventListener('devicechange', refreshWebcam)
})

function onTriggerClick() {
	open.value = !open.value
}

function onUpdateOpen(value: boolean) {
	open.value = value
}

// Light dismiss, but on our terms. The native popover light-dismiss fires on the
// very pointerdown that opens the balloon from the "Connect to Camera" prompt
// elsewhere, so it flickered closed-then-reopened. The popover is manual and we
// dismiss here instead — closing on an outside pointerdown / Esc, but never for
// the trigger (it toggles itself), clicks inside the balloon, or a
// `[data-camera-connect]` prompt button (which must keep us open).
useEventListener(
	'pointerdown',
	e => {
		if (!open.value) return
		const target = e.target as Element | null
		if (!target) return
		if (trigger.value?.contains(target)) return
		if (target.closest('[data-camera-connect]')) return
		if (menu.value?.closest('.TqBalloon')?.contains(target)) return
		open.value = false
	},
	{capture: true}
)

useEventListener('keydown', e => {
	if (e.key === 'Escape' && open.value) open.value = false
})

// Keep focus on the trigger while the popup is up (popup buttons use
// mousedown.prevent, so focus stays here), which also keeps the Tweeq title bar
// — an Electron drag region — in its `no-drag` state while interacting.
watch(open, isOpen => {
	if (isOpen) trigger.value?.focus()
})

// Another part of the app (the "Connect to Camera" prompt in Camera Control)
// can ask us to open and briefly flash for attention — the same flash the
// Balloon/InputButton use, shared so it reads identically.
const {flashing, flash} = Tq.useFlash()

watch(
	() => camera.connectPromptNonce,
	() => {
		open.value = true
		flash()
	}
)

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
	<button
		ref="trigger"
		class="trigger"
		:class="{flashing}"
		@click="onTriggerClick"
	>
		<Tq.Icon class="trigger-icon" :icon="icon" />
		<span class="trigger-label">{{ label }}</span>
		<Tq.Icon class="trigger-chevron" icon="mdi:chevron-down" />
	</button>

	<Tq.Popover
		:reference="trigger ?? null"
		:open="open"
		placement="bottom-start"
		arrow
		:flash="flashing"
		:light-dismiss="false"
		exit-transition
		@update:open="onUpdateOpen"
	>
		<div ref="menu" class="camera-menu">
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
					:disabled="camera.isConnecting || !hasWebcam"
					:tooltip="hasWebcam ? undefined : 'No webcam found'"
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

	// The same attention flash as the Balloon/InputButton (this bespoke dropdown
	// trigger isn't an InputButton, so it borrows the shared useFlash() state).
	// Glow only — no scale (it sits in the title bar, where a bump reads as jitter).
	&.flashing
		animation trigger-flash .6s ease-in-out 2

@keyframes trigger-flash
	0%, 100%
		box-shadow 0 0 0 0 transparent
	50%
		box-shadow 0 0 0 2px var(--tq-color-accent), 0 0 10px 1px var(--tq-color-accent)

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
// Balloon now; the menu only lays out its rows. The attention flash lives on the
// Balloon itself (forwarded via the Popover's `flash` prop).
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
