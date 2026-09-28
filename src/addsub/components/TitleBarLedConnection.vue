<script lang="ts" setup>
/**
 * Title-bar indicator + popover for the LED wall (stores/led.ts): connection
 * state at a glance, connect/disconnect and the quick outputs. Same
 * interaction pattern as the machine and camera popups.
 */
import * as Tq from 'tweeq'
import {computed, ref, watch} from 'vue'

import {useLedStore} from '../stores/led'

const led = useLedStore()

const open = ref(false)
const trigger = ref<HTMLElement>()
let lastDismissAt = 0

function onTriggerClick() {
	if (performance.now() - lastDismissAt < 200) return
	open.value = !open.value
}

function onUpdateOpen(value: boolean) {
	if (!value) lastDismissAt = performance.now()
	open.value = value
}

watch(open, isOpen => {
	if (isOpen) trigger.value?.focus()
})

const stateText = computed(() => {
	if (!led.connected) return led.connecting ? 'Connecting…' : 'Not connected'
	const i = led.info
	const px = i?.lines.reduce((a, l) => a + l.count, 0)
	return i ? `v${i.version} · ${i.lines.length} lines · ${px} px` : 'Connected'
})

const modeText = computed(() => {
	if (!led.connected) return ''
	if (led.chasing) return 'chase'
	if (led.workLight) return 'work light'
	if (led.liveLight) return led.liveInfo ? `live (Houdini) ${led.liveInfo.fps.toFixed(0)} fps` : 'live (waiting)'
	if (led.faceLight) return 'faces'
	if (led.shown) return led.shown.file
	return led.followCapture ? 'follow (no lighting for this frame)' : 'manual'
})

const tooltip = computed(() => `LED Wall: ${stateText.value}${modeText.value ? ` — ${modeText.value}` : ''}`)

const stateClass = computed(() => {
	if (!led.connected) return ''
	if (led.lastError) return 'alarm'
	if (led.chasing || led.workLight) return 'busy'
	return ''
})
</script>

<template>
	<button
		ref="trigger"
		v-tooltip="tooltip"
		class="trigger"
		:class="stateClass"
		@click="onTriggerClick"
	>
		<Tq.IconIndicator icon="mdi:led-strip-variant" :active="led.connected" glow />
	</button>
	<Tq.Popover
		:reference="trigger ?? null"
		:open="open"
		placement="bottom-end"
		arrow
		exit-transition
		@update:open="onUpdateOpen"
	>
		<div class="menu">
			<div class="head">
				<span class="name">LED Wall</span>
				<span class="state" :class="stateClass">{{ stateText }}</span>
			</div>
			<div v-if="led.lastError" class="alarm-row">{{ led.lastError }}</div>
			<Tq.InputGroup>
				<Tq.InputButton
					:label="led.connected ? 'Disconnect' : 'Connect…'"
					:icon="led.connected ? 'mdi:link-off' : 'mdi:link'"
					:disabled="led.connecting"
					@click="led.connected ? led.disconnect() : led.connect()"
				/>
				<Tq.InputButton
					label="White"
					icon="mdi:white-balance-sunny"
					:disabled="!led.connected"
					@click="led.fill(255, 255, 255)"
				/>
				<Tq.InputButton
					label="Off"
					icon="mdi:lightbulb-off-outline"
					:disabled="!led.connected"
					@click="led.blackout()"
				/>
			</Tq.InputGroup>
			<Tq.InputGroup>
				<Tq.InputButtonToggle
					v-model="led.workLight"
					label="Work light"
					icon="mdi:ceiling-light"
					:disabled="!led.connected"
				/>
				<Tq.InputButtonToggle
					v-model="led.liveLight"
					label="Live"
					icon="mdi:video-3d"
					:disabled="!led.connected"
				/>
				<Tq.InputButtonToggle
					v-model="led.faceLight"
					label="Faces"
					icon="mdi:cube-outline"
					:disabled="!led.connected"
				/>
				<Tq.InputButtonToggle
					v-model="led.followCapture"
					label="Follow"
					icon="mdi:auto-fix"
				/>
			</Tq.InputGroup>
			<div class="mode">
				{{ modeText || '—' }}
				<template v-if="led.lastShow"> · {{ led.lastShow.latencyMs.toFixed(0) }} ms</template>
				<template v-if="led.power"> · {{ led.power.totalAmps.toFixed(1) }} A{{ led.power.warning ? ' ⚠' : '' }}</template>
			</div>
		</div>
	</Tq.Popover>
</template>

<style lang="stylus" scoped>
.trigger
	display flex
	align-items center
	cursor pointer

	&.alarm :deep(.TqIconIndicator)
		color var(--tq-color-error, #e5484d)

	&.busy :deep(.TqIconIndicator)
		color orange

.menu
	width 17rem
	display flex
	flex-direction column
	gap 0.5em

.head
	display flex
	justify-content space-between
	align-items baseline
	gap 0.5em

.name
	font-weight bold

.state
	font-size 0.85em
	opacity 0.7

	&.alarm
		color var(--tq-color-error, #e5484d)
		opacity 1

.alarm-row
	font-size 0.85em
	color var(--tq-color-error, #e5484d)

.mode
	font-size 0.85em
	opacity 0.7
	overflow hidden
	text-overflow ellipsis
	white-space nowrap
</style>
