<script setup lang="ts">
import {useTweeq} from 'tweeq'
import {computed, reactive, ref, watch} from 'vue'

import type {MachineStore} from '@/stores/machine'
import {type AxesPosition, type Axis, PIN_LABELS} from '@/utils/fluidnc'

const props = defineProps<{
	machine: MachineStore
	/**
	 * Travel of each axis in machine coordinates: the range of the target
	 * sliders (shifted into work coordinates). Axes without one get a plain
	 * draggable number (±180° unclamped on rotary axes).
	 */
	limits?: Partial<Record<Axis, readonly [number, number]>>
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
	// Jogging says "not that target after all": the field follows the axis again.
	delete target[axis]
	props.machine.jogStepAxis(axis, sign).catch(() => {})
}

//------------------------------------------------------------------------------
// Move to a typed / dragged position. The work position is an input: it
// follows the axis until it's edited, then holds the edit as a target that
// only "Go" sends (an absolute jog at the jog feed, so it can be cancelled).
// Right-click → "Reset to Default" drops the target.

/** Positions are reported to 3 decimals. */
const POSITION_EPSILON = 0.0005

const target = reactive<AxesPosition>({})

function targetRange(axis: Axis) {
	const lim = props.limits?.[axis]
	if (lim) {
		// Machine → work: subtract the work coordinate offset.
		const wco = (props.machine.mpos[axis] ?? 0) - (props.machine.wpos[axis] ?? 0)
		return {min: lim[0] - wco, max: lim[1] - wco, clamp: true}
	}
	if (axisInfo(axis).unit === 'deg') return {min: -180, max: 180, clamp: false}
	return {min: undefined, max: undefined, clamp: false}
}

function isTargetDirty(axis: Axis) {
	const t = target[axis]
	const current = props.machine.wpos[axis]
	return (
		t !== undefined &&
		current !== undefined &&
		Math.abs(t - current) > POSITION_EPSILON
	)
}

function setTarget(axis: Axis, value: number) {
	const current = props.machine.wpos[axis]
	if (current === undefined) return
	if (target[axis] === undefined) {
		// An axis outside the slider's range makes the input emit the clamped
		// position on its own: not an edit.
		const {min, max, clamp} = targetRange(axis)
		const shown = clamp
			? Math.min(Math.max(current, min ?? -Infinity), max ?? Infinity)
			: current
		if (Math.abs(value - shown) <= POSITION_EPSILON) return
	}
	if (Math.abs(value - current) <= POSITION_EPSILON) delete target[axis]
	else target[axis] = value
}

/**
 * A focused input keeps showing what was typed, not the model — but this one
 * is also the position readout. Let go of it once the edit is confirmed so
 * it follows the axis again.
 */
function releaseFocus() {
	const el = document.activeElement
	if (el instanceof HTMLElement && el.closest('.position-input')) el.blur()
}

function goToTarget(axis: Axis) {
	const value = target[axis]
	if (value === undefined) return
	props.machine.jog({[axis]: value}, {relative: false}).catch(() => {})
}

// Arrived (or disconnected): the field follows the axis again.
watch(
	() => [props.machine.wpos, props.machine.connected] as const,
	([, connected]) => {
		for (const axis of Object.keys(target) as Axis[]) {
			if (!connected || !isTargetDirty(axis)) delete target[axis]
		}
	}
)

function goTooltip(axis: Axis) {
	const name = axis.toUpperCase()
	return isTargetDirty(axis)
		? {
				title: `Move ${name} to ${fmt(target[axis], axis)}`,
				description: `Now at ${fmt(props.machine.wpos[axis], axis)}. Moves at the jog feed; right-click the value to drop the target.`,
			}
		: {
				title: `Move ${name}`,
				description: 'Edit the position on the left, then press this to move there.',
			}
}

//------------------------------------------------------------------------------
// Input pins

const otherPins = computed(() => {
	const {probe, others} = props.machine.pins
	return [...(probe ? ['P'] : []), ...others].map(letter => ({
		letter,
		label: PIN_LABELS[letter] ?? `Input ${letter}`,
	}))
})

function isLimitActive(axis: Axis) {
	return props.machine.pins.limits.includes(axis)
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

async function setWorkValue(axis: Axis) {
	const current = props.machine.wpos[axis] ?? 0
	const result = await Tq.modal.prompt(
		{value: current},
		{value: {type: 'number', precision: 3}},
		{title: `Set work ${axis.toUpperCase()} (current position becomes this value)`}
	)
	if (!result) return
	await props.machine.setWorkPosition({[axis]: result.value}).catch(() => {})
}

const canJog = computed(
	() =>
		props.machine.connected &&
		!props.machine.unidentified &&
		!props.machine.busy &&
		(props.machine.state === 'Idle' || props.machine.state === 'Jog')
)

// Layout choices from the machine definition (e.g. the Box Rig: compact
// work-only cells, 3 per row, no feed input, no "go to 0").
const panel = computed(() => props.machine.def.panel ?? {})
const gridLayout = computed(() => panel.value.layout === 'grid')
const gridColumns = computed(() => panel.value.gridColumns ?? 3)
const showFeed = computed(() => panel.value.showFeed !== false)
const showGoToZero = computed(() => panel.value.showGoToZero !== false)
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
					{{
						machine.unidentified
							? '(not identified)'
							: (machine.buildInfo?.machineName ?? '(unnamed)')
					}}
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

		<!-- Picked while held: it runs no line, so it can't be asked which
		     machine it is. Only resume / reset get through until then. -->
		<Tq.Parameter
			v-if="machine.unidentified"
			:label="machine.state ?? 'Hold'"
			icon="mdi:pause-octagon-outline"
		>
			<div class="held">
				<span class="held-text">
					The controller can't say which machine it is until it is released.
				</span>
				<div class="controls">
					<Tq.InputButton
						label="Resume"
						icon="mdi:play"
						:tooltip="{
							title: 'Resume (~)',
							description: 'Carries on with whatever motion was held.',
						}"
						@click="machine.resume()"
					/>
					<Tq.InputButton
						label="Reset"
						icon="mdi:restart-alert"
						:tooltip="{
							title: 'Soft reset (Ctrl-X)',
							description: 'Drops whatever motion was held.',
						}"
						@click="machine.reset()"
					/>
				</div>
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
				<span v-tooltip="machine.lastError" class="error-text">
					{{ machine.lastError }}
				</span>
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
		<Tq.Parameter
			label="Step"
			icon="mdi:ruler"
			:hint="{title: 'Jog step', description: 'mm per click (degrees on rotary axes)'}"
		>
			<Tq.InputRadio
				v-model="jogStep"
				:options="stepPresets"
				:labels="stepPresets.map(String)"
			/>
		</Tq.Parameter>
		<Tq.Parameter
			v-if="showFeed"
			label="Feed"
			icon="mdi:speedometer"
			:hint="{title: 'Jog feed rate', description: 'mm/min (degrees/min on rotary axes)'}"
		>
			<Tq.InputNumber
				v-model="jogFeed"
				:min="1"
				:max="20000"
				:step="10"
				suffix=" mm/min"
			/>
		</Tq.Parameter>

		<!-- Feed / rapid override (Grbl real-time, like cncjs' slider): acts on
		     the running program at once, echoed back in Ov: -->
		<Tq.Parameter
			v-if="showFeed"
			label="Override"
			icon="mdi:tune-variant"
			:hint="{
				title: 'Feed / rapid override',
				description: 'Real-time multiplier on the running program (10–200 % feed; 25/50/100 % rapids). Applies immediately, also while streaming G-code.',
			}"
		>
			<div class="override">
				<Tq.InputGroup>
					<Tq.InputButton label="−10" narrow :disabled="!machine.connected" @click="machine.feedOverride(-10)" />
					<Tq.InputButton label="−1" narrow :disabled="!machine.connected" @click="machine.feedOverride(-1)" />
					<Tq.InputButton
						:label="machine.override ? `${machine.override.feed}%` : '—'"
						tooltip="Back to 100 %"
						:disabled="!machine.connected"
						@click="machine.feedOverride(0)"
					/>
					<Tq.InputButton label="+1" narrow :disabled="!machine.connected" @click="machine.feedOverride(1)" />
					<Tq.InputButton label="+10" narrow :disabled="!machine.connected" @click="machine.feedOverride(10)" />
				</Tq.InputGroup>
				<Tq.InputRadio
					:modelValue="machine.override?.rapid ?? 100"
					:options="[25, 50, 100]"
					:labels="['25%', '50%', '100%']"
					:disabled="!machine.connected"
					@update:modelValue="machine.rapidOverride($event as 25 | 50 | 100)"
				/>
			</div>
		</Tq.Parameter>

		<!-- Input pins (Pn:): which limit switches read active right now -->
		<Tq.Parameter
			label="Limits"
			icon="mdi:electric-switch"
			:hint="{
				title: 'Limit switches',
				description: 'Inputs reading active in the last status report (Pn:). Both switches of an axis share its letter; an unwired input can read active.',
			}"
		>
			<div class="pins" :class="{offline: !machine.connected}">
				<span
					v-for="axis in machine.def.axes"
					:key="axis"
					v-tooltip="`${axis.toUpperCase()} limit switch: ${isLimitActive(axis) ? 'pressed' : 'clear'}`"
					class="pin"
					:class="{active: isLimitActive(axis)}"
				>
					{{ axis.toUpperCase() }}
				</span>
				<span
					v-for="pin in otherPins"
					:key="pin.letter"
					v-tooltip="`${pin.label}: active`"
					class="pin other active"
				>
					{{ pin.label }}
				</span>
			</div>
		</Tq.Parameter>

		<!-- Axes, compact: one cell per axis (work position, jog ±, zero / set),
		     `gridColumns` per row — e.g. X Y Z over A B C for the rig. -->
		<li
			v-if="gridLayout"
			class="axes-cells"
			:style="{gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`}"
		>
			<div v-for="axis in machine.def.axes" :key="axis" class="cell">
				<div class="cell-head">
					<span class="cell-label" :class="{limit: isLimitActive(axis)}">
						{{ axisInfo(axis).label ?? axis.toUpperCase() }}
					</span>
					<span class="work-tools">
						<Tq.InputButton
							icon="mdi:numeric-0-circle-outline"
							narrow
							subtle
							:tooltip="{
								title: `Zero ${axis.toUpperCase()} here`,
								description: `The current position becomes work ${axis.toUpperCase()} = 0 (G10 L20). Nothing moves.`,
							}"
							:disabled="!machine.connected"
							@click="machine.zeroWork([axis])"
						/>
						<Tq.InputButton
							icon="mdi:pencil-outline"
							narrow
							subtle
							:tooltip="{
								title: `Set ${axis.toUpperCase()}…`,
								description: `Enter the work ${axis.toUpperCase()} value of the current position (G10 L20). Nothing moves.`,
							}"
							:disabled="!machine.connected"
							@click="setWorkValue(axis)"
						/>
					</span>
				</div>
				<div class="cell-target">
					<Tq.InputNumber
						v-if="machine.wpos[axis] !== undefined"
						v-tooltip="{
							title: 'Work position',
							description: `WPos, relative to the G54 origin (machine ${fmt(machine.mpos[axis], axis)}). Edit it, then press the button on the right to move there.`,
						}"
						class="position-input cell-pos"
						:class="{dirty: isTargetDirty(axis)}"
						:modelValue="target[axis] ?? machine.wpos[axis]!"
						:min="targetRange(axis).min"
						:max="targetRange(axis).max"
						:clampMin="targetRange(axis).clamp"
						:clampMax="targetRange(axis).clamp"
						:step="0.001"
						:default="machine.wpos[axis]"
						@update:modelValue="setTarget(axis, $event)"
						@confirm="releaseFocus"
					/>
					<span v-else class="pos cell-pos tq-font-numeric">—</span>
					<Tq.InputButton
						icon="mdi:crosshairs-gps"
						narrow
						:subtle="!isTargetDirty(axis)"
						:tooltip="goTooltip(axis)"
						:disabled="!canJog || !isTargetDirty(axis)"
						@click="goToTarget(axis)"
					/>
				</div>
				<div class="cell-jog">
					<Tq.InputButton
						icon="mdi:minus"
						:disabled="!canJog"
						@click="jog(axis, -1)"
					/>
					<Tq.InputButton
						icon="mdi:plus"
						:disabled="!canJog"
						@click="jog(axis, 1)"
					/>
				</div>
			</div>
		</li>

		<!-- Axes, rows: jog ± around the machine position, then the work
		     position (editable: a target for "go") with "zero here" /
		     "set value" (G10 L20) -->
		<li v-if="!gridLayout" class="axes-head axis-grid">
			<span></span>
			<span class="col-label">machine</span>
			<span></span>
			<span class="col-label">work</span>
			<span></span>
		</li>
		<Tq.Parameter
			v-for="axis in gridLayout ? [] : machine.def.axes"
			:key="axis"
			:label="axisInfo(axis).label ?? axis.toUpperCase()"
		>
			<div class="axis axis-grid">
				<Tq.InputButton
					icon="mdi:minus"
					narrow
					:disabled="!canJog"
					@click="jog(axis, -1)"
				/>
				<span
					v-tooltip="{
						title: 'Machine position',
						description: 'MPos, from the homing origin',
					}"
					class="pos tq-font-numeric"
				>
					{{ fmt(machine.mpos[axis], axis) }}
				</span>
				<Tq.InputButton
					icon="mdi:plus"
					narrow
					:disabled="!canJog"
					@click="jog(axis, 1)"
				/>
				<Tq.InputNumber
					v-if="machine.wpos[axis] !== undefined"
					v-tooltip="{
						title: 'Work position',
						description: `WPos, relative to the G54 origin (machine ${fmt(machine.mpos[axis], axis)}). Edit it, then press the button on the right to move there.`,
					}"
					class="position-input work"
					:class="{dirty: isTargetDirty(axis)}"
					:modelValue="target[axis] ?? machine.wpos[axis]!"
					:min="targetRange(axis).min"
					:max="targetRange(axis).max"
					:clampMin="targetRange(axis).clamp"
					:clampMax="targetRange(axis).clamp"
					:step="0.001"
					:default="machine.wpos[axis]"
					@update:modelValue="setTarget(axis, $event)"
					@confirm="releaseFocus"
				/>
				<span v-else class="pos work tq-font-numeric">—</span>
				<span class="work-tools">
					<Tq.InputButton
						icon="mdi:crosshairs-gps"
						narrow
						:subtle="!isTargetDirty(axis)"
						:tooltip="goTooltip(axis)"
						:disabled="!canJog || !isTargetDirty(axis)"
						@click="goToTarget(axis)"
					/>
					<Tq.InputButton
						icon="mdi:numeric-0-circle-outline"
						narrow
						subtle
						:tooltip="{
							title: `Zero ${axis.toUpperCase()} here`,
							description: `The current position becomes work ${axis.toUpperCase()} = 0 (G10 L20). Nothing moves.`,
						}"
						:disabled="!machine.connected"
						@click="machine.zeroWork([axis])"
					/>
					<Tq.InputButton
						icon="mdi:pencil-outline"
						narrow
						subtle
						:tooltip="{
							title: `Set ${axis.toUpperCase()}…`,
							description: `Enter the work ${axis.toUpperCase()} value of the current position (G10 L20). Nothing moves.`,
						}"
						:disabled="!machine.connected"
						@click="setWorkValue(axis)"
					/>
				</span>
			</div>
		</Tq.Parameter>
		<Tq.Parameter label="Work" icon="mdi:axis-arrow" hint="Work coordinate system (G54): zero all axes here">
			<div class="controls">
				<Tq.InputButton
					label="Zero all here"
					icon="mdi:numeric-0-circle-outline"
					:disabled="!machine.connected"
					@click="machine.zeroWork()"
				/>
				<Tq.InputButton
					v-if="showGoToZero"
					label="Go to 0"
					icon="mdi:target"
					:disabled="!canJog"
					@click="machine.goToWork()"
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
		<template v-if="$props.console !== false">
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

.held
	display flex
	flex-direction column
	gap var(--tq-gap-control)

.held-text
	font-size 0.85em
	color orange

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

// One column template shared by the header and every axis row, so the
// "machine" / "work" captions sit exactly over their numbers. The fixed columns
// are the width of a narrow icon-only InputButton (icon + 1px padding each side);
// the last one holds the three work tools.
.axis-grid
	--jog-button calc(var(--tq-icon-size) + 2px)
	display grid
	grid-template-columns var(--jog-button) 1fr var(--jog-button) 1fr calc(3 * var(--jog-button))
	align-items center
	gap var(--tq-gap-group)

// Compact layout: full-width row of cells, `gridColumns` per line.
.axes-cells
	grid-column 1 / 3
	list-style none
	display grid
	gap var(--tq-gap-group) var(--tq-gap-control)
	padding var(--tq-gap-group) 0

.cell
	--jog-button calc(var(--tq-icon-size) + 2px)
	--limit-color orange
	display flex
	flex-direction column
	gap var(--tq-gap-group)
	min-width 0

.cell-head
	display flex
	align-items center
	justify-content space-between
	gap var(--tq-gap-group)

.cell-label
	font-weight 600

	// Its limit switch reads active.
	&.limit
		color var(--limit-color)

// Position input + "go".
.cell-target
	display grid
	grid-template-columns minmax(0, 1fr) var(--jog-button)
	align-items center
	gap var(--tq-gap-group)

// An edited position that the axis isn't at (yet).
.dirty
	color var(--tq-color-accent)

// − and + fill the cell width (bigger targets than the narrow icon buttons).
.cell-jog
	display grid
	grid-template-columns 1fr 1fr
	gap var(--tq-gap-group)

	:deep(.TqInputButton)
		width 100%
		justify-content center

.axes-head
	grid-column 2 / 3
	list-style none
	font-size 0.7em
	letter-spacing 0.05em
	text-transform uppercase
	color var(--tq-color-text-mute)

.col-label
	text-align right
	padding-right 0.5em

.pos
	text-align right
	padding-right 0.5em
	font-variant-numeric tabular-nums

	&.work
		color var(--tq-color-text-mute)

.work-tools
	display flex

.pins
	--limit-color orange
	display flex
	flex-wrap wrap
	gap 0 var(--tq-gap-section)

	&.offline
		opacity 0.4

// A lamp per input (not a button): a dot that lights up, then its name.
.pin
	display flex
	align-items center
	gap 0.3em
	color var(--tq-color-text-mute)
	font-size 0.85em
	font-weight 600
	line-height var(--tq-icon-size)

	&:before
		content ''
		width 0.6em
		height 0.6em
		border-radius 50%
		background var(--tq-color-border)

	&.active
		color var(--limit-color)

		&:before
			background var(--limit-color)
			box-shadow 0 0 0.5em var(--limit-color)

.controls
	display flex
	flex-wrap wrap
	gap var(--tq-gap-group)

.override
	display flex
	flex-direction column
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
