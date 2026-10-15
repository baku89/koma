<script lang="ts" setup>
/**
 * Title-bar indicator + popover for the LED wall (stores/led.ts): connection
 * state at a glance, connect/disconnect and the quick outputs. Same
 * interaction pattern as the machine and camera popups.
 */
import * as Tq from 'tweeq'
import {computed, ref, watch} from 'vue'

import {LED_MODE_ICONS, LED_MODE_LABELS, LED_MODES, useLedStore} from '../stores/led'

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
	const port = led.portLabel ? ` (${led.portLabel})` : ''
	return (i ? `v${i.version} · ${i.lines.length} lines · ${px} px` : 'Connected') + port
})

const modeText = computed(() => {
	if (!led.connected) return ''
	if (led.chasing) return 'chase'
	switch (led.mode) {
		case 'work':
			return 'work light'
		case 'live':
			return led.liveInfo ? `live (Houdini) ${led.liveInfo.fps.toFixed(0)} fps` : 'live (waiting)'
		case 'faces':
			return 'faces'
		default:
			return 'off (manual)'
	}
})

const tooltip = computed(() => `LED Wall: ${stateText.value}${modeText.value ? ` — ${modeText.value}` : ''}`)

const stateClass = computed(() => {
	if (!led.connected) return ''
	if (led.lastError) return 'alarm'
	if (led.chasing || led.mode === 'work') return 'busy'
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
			<Tq.InputButton
				:label="led.connected ? 'Disconnect' : 'Connect…'"
				:icon="led.connected ? 'mdi:link-off' : 'mdi:link'"
				:disabled="led.connecting"
				@click="led.connected ? led.disconnect() : led.connect()"
			/>
			<Tq.InputRadio
				:modelValue="led.mode"
				:options="[...LED_MODES]"
				:labels="LED_MODE_LABELS"
				:tooltips="LED_MODE_LABELS"
				:icons="LED_MODE_ICONS"
				@update:modelValue="led.setMode($event)"
			/>
			<div class="mode">
				{{ modeText || '—' }}
				<template v-if="led.lastShow"> · {{ led.lastShow.latencyMs.toFixed(0) }} ms</template>
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
	// As wide as the widest row of buttons; the text rows wrap inside that.
	width max-content
	min-width 17rem
	display flex
	flex-direction column
	gap 0.5em

	:deep(.TqInputGroup > *)
		flex-grow 1

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

// Text rows take the menu's width instead of setting it.
.alarm-row, .mode
	width 0
	min-width 100%

.mode
	font-size 0.85em
	opacity 0.7
	overflow hidden
	text-overflow ellipsis
	white-space nowrap
</style>
