<script setup lang="ts">
import {useTweeq} from 'tweeq'
import {computed, reactive, ref, useTemplateRef,watch} from 'vue'

import {
	homingLines,
	type HomingSteps,
	type MachineStore,
} from '@/stores/machine'
import {type AxesPosition, type Axis, PIN_LABELS} from '@/utils/fluidnc'

const props = withDefaults(
	defineProps<{
		machine: MachineStore
		/**
		 * Travel of each axis in machine coordinates: the range of the target
		 * sliders (shifted into work coordinates). Axes without one get a plain
		 * draggable number (±180° unclamped on rotary axes).
		 */
		limits?: Partial<Record<Axis, readonly [number, number]>>
		/**
		 * Show the typed G-code line (+ the tail of the serial log) under Step.
		 * Vue casts an absent boolean prop to `false`, hence the explicit default.
		 */
		console?: boolean
	}>(),
	{console: true}
)

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
		const wco =
			(props.machine.mpos[axis] ?? 0) - (props.machine.wpos[axis] ?? 0)
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
				description:
					'Edit the work position on the left, then press this to move there.',
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
const $console = useTemplateRef<InstanceType<typeof Tq.InputString>>('$console')

async function sendConsole() {
	const line = consoleInput.value.trim()
	if (!line) return
	consoleInput.value = ''
	// InputString keeps showing what was typed while it has focus (and the
	// Send button's mousedown.prevent leaves focus in the field), so blur it
	// to let the cleared model through, then put the caret back for the
	// next line.
	$console.value?.blur()
	$console.value?.select()
	await props.machine.send(line).catch(() => {})
}

const recentLog = computed(() => props.machine.log.slice(-12))

/** The whole log (not just the visible tail) as text, for the clipboard. */
function formatLog() {
	return props.machine.log
		.map(e => (e.dir === 'tx' ? '› ' : e.dir === 'sys' ? '• ' : '') + e.text)
		.join('\n')
}

async function copyLog() {
	try {
		await navigator.clipboard.writeText(formatLog())
	} catch (e) {
		// eslint-disable-next-line no-console
		console.error('[MachinePanel] Could not copy the log', e)
	}
}

async function setWorkValue(axis: Axis) {
	const current = props.machine.wpos[axis] ?? 0
	const result = await Tq.modal.prompt(
		{value: current},
		{value: {type: 'number', precision: 3}},
		{
			title: `Set work ${axis.toUpperCase()} (current position becomes this value)`,
		}
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

function home(steps?: HomingSteps) {
	props.machine.home(steps).catch(() => {})
}

const canHome = computed(
	() =>
		props.machine.connected &&
		!props.machine.unidentified &&
		!props.machine.busy
)

// The machine's own homing groups, else the linear / rotary axes as a group
// each, one axis at a time — only when it has both (otherwise a group is the
// same as "All").
const homeGroups = computed<{label: string; steps: HomingSteps}[]>(() => {
	const own = props.machine.def.panel?.homeGroups
	if (own) return [...own]
	const groups = [
		['x', 'y', 'z'],
		['a', 'b', 'c'],
	].map(g => props.machine.def.axes.filter(a => g.includes(a)))
	const present = groups.filter(g => g.length > 0)
	if (present.length < 2) return []
	return present.map(steps => ({label: steps.join('').toUpperCase(), steps}))
})

function homeTooltip(label: string, steps: HomingSteps) {
	return {title: `Home ${label}`, description: homingLines(steps).join(' → ')}
}

// Layout choices from the machine definition (e.g. the Box Rig: X Y Z over
// A B C, no feed input).
const panel = computed(() => props.machine.def.panel ?? {})
const gridColumns = computed(() => panel.value.gridColumns ?? 3)
const showFeed = computed(() => panel.value.showFeed !== false)
const outputs = computed(() =>
	(['flood', 'mist'] as const).flatMap(which => {
		const label = panel.value.outputs?.[which]
		return label ? [{which, label}] : []
	})
)
</script>

<template>
	<Tq.ParameterGroup
		:name="`machine.${machine.def.id}`"
		:label="machine.def.label"
		:icon="machine.def.icon"
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
					<Tq.InputButton
						label="Restart"
						icon="mdi:power-cycle"
						:tooltip="{
							title: 'Restart the controller ($Bye)',
							description:
								'Reboots the ESP32 as after a power cycle. Not processed while held — Reset first.',
						}"
						@click="machine.restart()"
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
			label="Streaming"
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
			:hint="{
				title: 'Jog step',
				description: 'mm per click (degrees on rotary axes)',
			}"
		>
			<Tq.InputRadio
				v-model="jogStep"
				:options="stepPresets"
				:labels="stepPresets.map(String)"
			/>
		</Tq.Parameter>
		<!-- Typed G-code (one line → ok) and the tail of the serial log -->
		<template v-if="props.console">
			<Tq.Parameter
				label="G-code"
				icon="mdi:console-line"
				:hint="{
					title: 'Send a line',
					description:
						'G-code or $-command, sent as typed with Enter or the Send button (not on blur). The chevron shows the last lines of the serial log (status reports from the ? poll are left out); the copy button puts the whole log on the clipboard.',
				}"
			>
				<!--
					Deliberately not @confirm: Tq.InputString confirms on blur too, and a
					typed G-code line must only go out on an explicit Enter / Send.
					Capture phase: the model must be cleared before InputString's own
					Enter handler schedules its nextTick (display = model), or the
					stale text is written back.
				-->
				<div class="row" @keydown.enter.capture="sendConsole">
					<Tq.InputString
						ref="$console"
						v-model="consoleInput"
						font="monospace"
						:disabled="!machine.connected"
					/>
					<Tq.InputButton
						icon="mdi:send"
						subtle
						narrow
						tooltip="Send"
						:disabled="!machine.connected || !consoleInput.trim()"
						@click="sendConsole"
					/>
					<Tq.InputButton
						v-if="showLog"
						icon="mdi:content-copy"
						subtle
						narrow
						tooltip="Copy log"
						:disabled="machine.log.length === 0"
						@click="copyLog"
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
					{{ entry.dir === 'tx' ? '› ' : entry.dir === 'sys' ? '• ' : ''
					}}{{ entry.text }}
				</div>
			</li>
		</template>
		<Tq.Parameter
			v-if="showFeed"
			label="Feed"
			icon="mdi:speedometer"
			:hint="{
				title: 'Jog feed rate',
				description: 'mm/min (degrees/min on rotary axes)',
			}"
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
				description:
					'Real-time multiplier on the running program (10–200 % feed; 25/50/100 % rapids). Applies immediately, also while streaming G-code.',
			}"
		>
			<div class="override">
				<Tq.InputGroup>
					<Tq.InputButton
						label="−10"
						narrow
						:disabled="!machine.connected"
						@click="machine.feedOverride(-10)"
					/>
					<Tq.InputButton
						label="−1"
						narrow
						:disabled="!machine.connected"
						@click="machine.feedOverride(-1)"
					/>
					<Tq.InputButton
						:label="machine.override ? `${machine.override.feed}%` : '—'"
						tooltip="Back to 100 %"
						:disabled="!machine.connected"
						@click="machine.feedOverride(0)"
					/>
					<Tq.InputButton
						label="+1"
						narrow
						:disabled="!machine.connected"
						@click="machine.feedOverride(1)"
					/>
					<Tq.InputButton
						label="+10"
						narrow
						:disabled="!machine.connected"
						@click="machine.feedOverride(10)"
					/>
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

		<!-- Coolant outputs (M7 / M8 / M9), one switch each, labelled by what
		     is wired to them. State comes from the A: letters of the status
		     reports. -->
		<Tq.Parameter
			v-for="o in outputs"
			:key="o.which"
			:label="o.label"
			icon="mdi:fan"
			:hint="{
				title: o.label,
				description: `${o.which === 'flood' ? 'M8' : 'M7'} on / M9 off, sent like any G-code line. The G-code of a cut can switch it too.`,
			}"
		>
			<Tq.InputSwitch
				:modelValue="machine.coolant[o.which]"
				:disabled="!machine.connected || machine.busy"
				@update:modelValue="machine.setCoolant(o.which, $event)"
			/>
		</Tq.Parameter>

		<!-- Axes: one cell per axis, `gridColumns` per row (e.g. X Y Z over
		     A B C for the rig). Head: name + limit switch lamp, the machine
		     position (dimmed, read-only), zero / set (G10 L20). Then the work
		     position (editable: a target for "go"), and jog ± with home set
		     apart. -->
		<li
			class="axes-cells"
			:style="{gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`}"
		>
			<div v-for="axis in machine.def.axes" :key="axis" class="cell">
				<div class="cell-head">
					<span
						v-tooltip="
							`${axis.toUpperCase()} limit switch: ${isLimitActive(axis) ? 'pressed' : 'clear'}`
						"
						class="cell-label"
						:class="{limit: isLimitActive(axis), offline: !machine.connected}"
					>
						{{ axisInfo(axis).label ?? axis.toUpperCase() }}
					</span>
					<span
						v-tooltip="{
							title: 'Machine position',
							description: 'MPos, from the homing origin.',
						}"
						class="cell-machine tq-font-numeric"
					>
						{{ fmt(machine.connected ? machine.mpos[axis] : undefined, axis) }}
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
							description:
								'WPos, relative to the G54 origin. Edit it, then press the button on the right to move there; the buttons above zero / set it here.',
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
					<Tq.InputGroup>
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
					</Tq.InputGroup>
					<Tq.InputButton
						icon="mdi:home-outline"
						narrow
						subtle
						:tooltip="homeTooltip(axis.toUpperCase(), [axis])"
						:disabled="!canHome"
						@click="home([axis])"
					/>
				</div>
			</div>
		</li>

		<!-- Other inputs (Pn:), only while one reads active -->
		<Tq.Parameter
			v-if="otherPins.length"
			label="Inputs"
			icon="mdi:electric-switch"
		>
			<div class="pins">
				<span v-for="pin in otherPins" :key="pin.letter" class="pin">
					{{ pin.label }}
				</span>
			</div>
		</Tq.Parameter>

		<!-- Homing: linear / rotary group, or everything (the controller's cycles) -->
		<Tq.Parameter label="Home" icon="mdi:home">
			<div class="controls">
				<Tq.InputButton
					v-for="group in homeGroups"
					:key="group.label"
					:label="group.label"
					:tooltip="homeTooltip(group.label, group.steps)"
					:disabled="!canHome"
					@click="home(group.steps)"
				/>
				<Tq.InputButton
					label="All"
					icon="mdi:home"
					:tooltip="{
						title: 'Home all axes',
						description:
							'$H: the homing cycles of the controller\'s config, in their order.',
					}"
					:disabled="!canHome"
					@click="home()"
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
				<Tq.InputButton
					icon="mdi:power-cycle"
					:tooltip="{
						title: 'Restart the controller ($Bye)',
						description:
							'Reboots the ESP32 as after a power cycle: config.yaml is re-read, homing is lost.',
					}"
					:disabled="!machine.connected"
					@click="machine.restart()"
				/>
			</div>
		</Tq.Parameter>
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

// One cell per axis, `gridColumns` per line.
.axes-cells
	grid-column 1 / 3
	list-style none
	display grid
	gap var(--tq-gap-section) var(--tq-gap-control)
	padding var(--tq-gap-group) 0

.cell
	--jog-button calc(var(--tq-icon-size) + 2px)
	--limit-color #f2c200
	display flex
	flex-direction column
	gap var(--tq-gap-group)
	min-width 0

// Name + limit lamp, machine position, zero / set.
.cell-head
	display flex
	align-items center
	gap var(--tq-gap-group)

// The axis name with its limit switch lamp: grey, yellow (both) while the
// switch reads active.
.cell-label
	display flex
	align-items center
	gap 0.35em
	font-weight 600

	&:after
		content ''
		width 0.55em
		height 0.55em
		border-radius 50%
		background var(--tq-color-border)

	&.offline:after
		opacity 0.4

	&.limit
		color var(--limit-color)

		&:after
			background var(--limit-color)
			box-shadow 0 0 0.5em var(--limit-color)

.cell-machine
	flex 1 1 0
	min-width 0
	overflow hidden
	text-align right
	white-space nowrap
	font-size 0.85em
	font-variant-numeric tabular-nums
	color var(--tq-color-text-mute)

// Position input + "go".
.cell-target
	display grid
	grid-template-columns minmax(0, 1fr) var(--jog-button)
	align-items center
	gap var(--tq-gap-group)

// An edited position that the axis isn't at (yet).
.dirty
	color var(--tq-color-accent)

// − and + as one group filling the cell (bigger targets than the narrow icon
// buttons); home sits apart from them, under "go".
.cell-jog
	display grid
	grid-template-columns minmax(0, 1fr) var(--jog-button)
	align-items center
	gap var(--tq-gap-related)

	:deep(.TqInputGroup .TqInputButton)
		flex 1 1 0
		min-width 0
		justify-content center

.pos
	text-align right
	padding-right 0.5em
	font-variant-numeric tabular-nums

.work-tools
	display flex

.pins
	--limit-color #f2c200
	display flex
	flex-wrap wrap
	gap 0 var(--tq-gap-section)

// A lamp per active input (not a button): a lit dot, then its name.
.pin
	display flex
	align-items center
	gap 0.3em
	color var(--limit-color)
	font-size 0.85em
	font-weight 600
	line-height var(--tq-icon-size)

	&:before
		content ''
		width 0.6em
		height 0.6em
		border-radius 50%
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
	user-select text
	cursor text
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
