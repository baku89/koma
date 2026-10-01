<script lang="ts" setup>
/**
 * Title-bar indicator + popover for one FluidNC machine store: connection
 * state at a glance, connect/disconnect, a one-line console and the log.
 * Mirrors the camera connection popup (click toggle, light-dismiss guard,
 * focus trick so the drag region doesn't swallow the click).
 */
import * as Tq from 'tweeq'
import {computed, nextTick, ref, watch} from 'vue'

import type {MachineStore} from '@/stores/machine'

const props = defineProps<{
	machine: MachineStore
	icon: string
}>()

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

const line = ref('')
const logEl = ref<HTMLPreElement | null>(null)

const logText = computed(() =>
	props.machine.log
		.slice(-200)
		.map(e => (e.dir === 'tx' ? '› ' : e.dir === 'sys' ? '• ' : '') + e.text)
		.join('\n')
)

watch(logText, async () => {
	await nextTick()
	if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
})

async function send() {
	const l = line.value.trim()
	if (!l) return
	line.value = ''
	await props.machine.send(l).catch(() => {})
}

const tooltip = computed(() => {
	const m = props.machine
	if (!m.connected) return `${m.def.label}: not connected`
	return `${m.def.label}: ${machineName.value} — ${m.state ?? '…'}`
})

const machineName = computed(() =>
	props.machine.unidentified
		? 'not identified'
		: (props.machine.buildInfo?.machineName ?? '')
)

const stateClass = computed(() => {
	const s = props.machine.state
	if (!props.machine.connected) return ''
	if (s === 'Alarm') return 'alarm'
	if (s === 'Run' || s === 'Jog' || s === 'Home') return 'busy'
	if (s === 'Hold' || s === 'Door') return 'hold'
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
		<Tq.IconIndicator :icon="icon" :active="machine.connected" glow />
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
				<span class="name">{{ machine.def.label }}</span>
				<span class="state" :class="stateClass">
					{{
						machine.connected
							? `${machineName} · ${machine.state ?? '…'}`
							: machine.connecting
								? 'Connecting…'
								: 'Not connected'
					}}
				</span>
			</div>
			<div v-if="machine.alarm" class="alarm-row">
				ALARM:{{ machine.alarm.code }} {{ machine.alarm.message }}
			</div>
			<div v-else-if="machine.lastError" class="error-row">
				{{ machine.lastError }}
			</div>
			<!-- Picked while held: only resume / reset get through until the
			     controller is released and can say which machine it is. -->
			<template v-if="machine.unidentified">
				<div class="held-row">
					The controller can't say which machine it is until it is released.
				</div>
				<Tq.InputGroup>
					<Tq.InputButton
						label="Resume"
						icon="mdi:play"
						tooltip="Resume (~): carries on with whatever motion was held"
						@click="machine.resume()"
					/>
					<Tq.InputButton
						label="Reset"
						icon="mdi:restart-alert"
						tooltip="Soft reset (Ctrl-X): drops whatever motion was held"
						@click="machine.reset()"
					/>
				</Tq.InputGroup>
			</template>
			<Tq.InputGroup>
				<Tq.InputButton
					:label="machine.connected ? 'Disconnect' : 'Connect…'"
					:icon="machine.connected ? 'mdi:link-off' : 'mdi:link'"
					:disabled="machine.connecting"
					@click="machine.connected ? machine.disconnect() : machine.connect()"
				/>
				<Tq.InputButton
					label="Unlock"
					icon="mdi:lock-open-variant"
					:disabled="!machine.connected || machine.unidentified"
					@click="machine.unlock()"
				/>
				<Tq.InputButton
					label="Home"
					icon="mdi:home"
					:disabled="!machine.connected || machine.unidentified || machine.busy"
					@click="machine.home()"
				/>
			</Tq.InputGroup>
			<Tq.InputGroup>
				<Tq.InputString
					v-model="line"
					font="monospace"
					:disabled="!machine.connected"
					@confirm="send"
				/>
				<Tq.InputButton label="Send" :disabled="!machine.connected" @click="send" />
			</Tq.InputGroup>
			<pre ref="logEl">{{ logText }}</pre>
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

	&.hold :deep(.TqIconIndicator)
		color orange

.menu
	width 17rem
	display flex
	flex-direction column
	gap 0.5em

	pre
		white-space pre-wrap
		overflow-wrap anywhere
		margin 0
		max-height 20lh
		overflow-y auto
		font-size 0.85em

.head
	display flex
	justify-content space-between
	align-items baseline
	gap 0.5em

.name
	font-weight bold

.state
	font-size 0.85em
	color var(--tq-color-text-mute)

	&.alarm
		color var(--tq-color-error, #e5484d)

	&.busy
		color var(--tq-color-accent)

	&.hold
		color orange

.alarm-row
	font-size 0.85em
	color var(--tq-color-error, #e5484d)

.error-row
	font-size 0.85em
	color var(--tq-color-text-mute)

.held-row
	font-size 0.85em
	color orange
</style>
