<script setup lang="ts">
import {useTweeq} from 'tweeq'
import {computed, ref} from 'vue'

import type {MachineStore} from '@/stores/machine'
import type {Axis} from '@/utils/fluidnc'

const props = defineProps<{
	machine: MachineStore
	/** Show the raw serial console (last lines + a G-code input). */
	console?: boolean
}>()

const Tq = useTweeq()

// Store fields bound with v-model. Going through computed setters keeps
// vue/no-mutating-props happy (the store is reactive; the prop itself isn't
// reassigned).
const jogStep = computed({
	get: () => props.machine.jogStep,
	set: v => props.machine.$patch({jogStep: v}),
})
const jogFeed = computed({
	get: () => props.machine.jogFeed,
	set: v => props.machine.$patch({jogFeed: v}),
})
function dismissError() {
	props.machine.$patch({lastError: null})
}

const stateLabel = computed(() => {
	const m = props.machine
	if (!m.connected) return m.connecting ? 'Connecting…' : 'Disconnected'
	const s = m.status
	if (!s) return '…'
	return s.subState !== undefined ? `${s.state}:${s.subState}` : s.state
})

const stateColor = computed(() => {
	const m = props.machine
	if (!m.connected) return 'var(--tq-color-text-mute)'
	switch (m.state) {
		case 'Idle':
			return 'var(--tq-color-text)'
		case 'Run':
		case 'Jog':
		case 'Home':
			return 'var(--tq-color-accent)'
		case 'Alarm':
			return 'var(--tq-color-error, #e5484d)'
		case 'Hold':
		case 'Door':
			return 'orange'
		default:
			return 'var(--tq-color-text)'
	}
})

function axisInfo(axis: Axis) {
	return props.machine.def.axisInfo?.[axis] ?? {unit: 'mm' as const}
}

function fmt(v: number | undefined, axis: Axis) {
	if (v === undefined) return '—'
	return axisInfo(axis).unit === 'deg' ? v.toFixed(3) : v.toFixed(3)
}

const stepPresets = [0.01, 0.1, 1, 10, 100]

function jog(axis: Axis, sign: 1 | -1) {
	props.machine.jogStepAxis(axis, sign).catch(() => {})
}

const showLog = Tq.config.ref(`machine.${props.machine.def.id}.showLog`, false)
const consoleInput = ref('')

async function sendConsole() {
	const line = consoleInput.value.trim()
	if (!line) return
	consoleInput.value = ''
	await props.machine.send(line).catch(() => {})
}

const recentLog = computed(() => props.machine.log.slice(-12))

const canJog = computed(
	() =>
		props.machine.connected &&
		!props.machine.busy &&
		(props.machine.state === 'Idle' || props.machine.state === 'Jog')
)
</script>

<template>
	<Tq.ParameterGroup
		:name="`machine.${machine.def.id}`"
		:label="machine.def.label"
		icon="game-icons:mechanical-arm"
	>
		<template #headingRight>
			<span class="state" :style="{color: stateColor}">{{ stateLabel }}</span>
		</template>

		<!-- Connection -->
		<Tq.Parameter v-if="!machine.connected" label="Port" icon="mdi:usb-port">
			<Tq.InputButton
				label="Connect…"
				icon="mdi:link"
				:disabled="machine.connecting"
				@click="machine.connect()"
			/>
		</Tq.Parameter>
		<Tq.Parameter v-else label="Port" icon="mdi:usb-port">
			<div class="row">
				<span class="name tq-font-numeric">
					{{ machine.buildInfo?.machineName ?? '(unnamed)' }}
				</span>
				<Tq.InputButton
					icon="mdi:link-off"
					tooltip="Disconnect"
					subtle
					narrow
					@click="machine.disconnect()"
				/>
			</div>
		</Tq.Parameter>

		<!-- Alarm / error -->
		<Tq.Parameter v-if="machine.alarm" label="Alarm" icon="mdi:alert">
			<div class="alarm">
				ALARM:{{ machine.alarm.code }} {{ machine.alarm.message }}
				<Tq.InputButton
					label="Unlock ($X)"
					icon="mdi:lock-open-variant"
					@click="machine.unlock()"
				/>
			</div>
		</Tq.Parameter>
		<Tq.Parameter
			v-else-if="machine.lastError"
			label="Error"
			icon="mdi:alert-circle-outline"
		>
			<div class="error">
				<span class="error-text">{{ machine.lastError }}</span>
				<Tq.InputButton
					icon="mdi:close"
					subtle
					narrow
					tooltip="Dismiss"
					@click="dismissError"
				/>
			</div>
		</Tq.Parameter>

		<!-- Streaming progress -->
		<Tq.Parameter
			v-if="machine.streamProgress"
			label="G-code"
			icon="mdi:file-code"
		>
			<span class="tq-font-numeric">
				{{ machine.streamProgress.index }} / {{ machine.streamProgress.total }}
			</span>
		</Tq.Parameter>

		<!-- Jog settings -->
		<Tq.Parameter label="Step" icon="mdi:ruler" hint="Jog step (mm / deg)">
			<Tq.InputRadio
				v-model="jogStep"
				:options="stepPresets"
				:labels="stepPresets.map(String)"
			/>
		</Tq.Parameter>
		<Tq.Parameter label="Feed" icon="mdi:speedometer" hint="Jog feed (mm/min)">
			<Tq.InputNumber v-model="jogFeed" :min="1" :max="20000" :step="10" />
		</Tq.Parameter>

		<!-- Axes -->
		<Tq.Parameter
			v-for="axis in machine.def.axes"
			:key="axis"
			:label="axisInfo(axis).label ?? axis.toUpperCase()"
		>
			<div class="axis">
				<Tq.InputButton
					icon="mdi:minus"
					narrow
					:disabled="!canJog"
					@click="jog(axis, -1)"
				/>
				<span
					class="pos tq-font-numeric"
					:title="`WPos ${fmt(machine.wpos[axis], axis)}`"
				>
					{{ fmt(machine.mpos[axis], axis) }}
				</span>
				<Tq.InputButton
					icon="mdi:plus"
					narrow
					:disabled="!canJog"
					@click="jog(axis, 1)"
				/>
			</div>
		</Tq.Parameter>

		<!-- Homing: one button per axis -->
		<Tq.Parameter label="Home" icon="mdi:home">
			<div class="controls">
				<Tq.InputButton
					v-for="axis in machine.def.axes"
					:key="axis"
					:label="axis.toUpperCase()"
					:disabled="!machine.connected || machine.busy"
					@click="machine.home([axis])"
				/>
				<Tq.InputButton
					label="All"
					icon="mdi:home"
					subtle
					:disabled="!machine.connected || machine.busy"
					@click="machine.home()"
				/>
			</div>
		</Tq.Parameter>

		<!-- Controls -->
		<Tq.Parameter label="Control" icon="mdi:gamepad-variant">
			<div class="controls">
				<Tq.InputButton
					icon="mdi:pause"
					tooltip="Feed hold (!)"
					:disabled="!machine.connected"
					@click="machine.feedHold()"
				/>
				<Tq.InputButton
					icon="mdi:play"
					tooltip="Resume (~)"
					:disabled="!machine.connected"
					@click="machine.resume()"
				/>
				<Tq.InputButton
					icon="mdi:cancel"
					tooltip="Cancel jog"
					:disabled="!machine.connected"
					@click="machine.jogCancel()"
				/>
				<Tq.InputButton
					icon="mdi:restart-alert"
					tooltip="Soft reset (Ctrl-X)"
					:disabled="!machine.connected"
					@click="machine.reset()"
				/>
			</div>
		</Tq.Parameter>

		<!-- Console -->
		<template v-if="console !== false">
			<Tq.Parameter label="Console" icon="mdi:console">
				<div class="row">
					<Tq.InputString
						v-model="consoleInput"
						font="monospace"
						:disabled="!machine.connected"
						@confirm="sendConsole"
					/>
					<Tq.InputButton
						:icon="showLog ? 'mdi:chevron-up' : 'mdi:chevron-down'"
						subtle
						narrow
						tooltip="Toggle log"
						@click="showLog = !showLog"
					/>
				</div>
			</Tq.Parameter>
			<li v-if="showLog" class="log">
				<div
					v-for="(entry, i) in recentLog"
					:key="i"
					class="log-line"
					:class="entry.dir"
				>
					{{ entry.dir === 'tx' ? '› ' : entry.dir === 'sys' ? '• ' : '' }}{{ entry.text }}
				</div>
			</li>
		</template>
	</Tq.ParameterGroup>
</template>

<style lang="stylus" scoped>
.state
	font-size 0.85em
	font-weight 600
	letter-spacing 0.02em

.row
	display flex
	align-items center
	gap var(--tq-gap-control)

	> :first-child
		flex 1 1 0
		min-width 0

.name
	overflow hidden
	text-overflow ellipsis
	white-space nowrap

.alarm
	display flex
	flex-direction column
	gap var(--tq-gap-control)
	color var(--tq-color-error, #e5484d)

.error
	display flex
	align-items center
	gap var(--tq-gap-control)
	color var(--tq-color-text-mute)

.error-text
	flex 1 1 0
	min-width 0
	font-size 0.85em
	overflow hidden
	text-overflow ellipsis
	white-space nowrap

.axis
	display grid
	grid-template-columns auto 1fr auto
	align-items center
	gap var(--tq-gap-group)

.pos
	text-align right
	padding-right 0.5em
	font-variant-numeric tabular-nums

.controls
	display flex
	flex-wrap wrap
	gap var(--tq-gap-group)

.log
	grid-column 1 / 3
	list-style none
	font-family var(--tq-font-code, monospace)
	font-size 0.75em
	line-height 1.4
	color var(--tq-color-text-mute)
	max-height 12em
	overflow auto
	padding var(--tq-gap-group) 0 var(--tq-gap-group) var(--tq-gap-section)
	background var(--tq-color-input)
	border-radius var(--tq-radius-input)

.log-line
	white-space pre-wrap
	word-break break-all

	&.tx
		color var(--tq-color-text)

	&.sys
		color var(--tq-color-accent)
</style>
