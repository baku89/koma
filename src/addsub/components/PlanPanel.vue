<script lang="ts" setup>
/**
 * Edit the plan of the *selected* timeline cell (viewport.currentFrame /
 * currentLayer): rig axes (work coordinates, as stored) as numbers with the
 * travel limits as sliders,
 * camera settings with the same inputs the camera panel uses (the connected
 * camera's option lists; a plain field while no camera is connected).
 *
 * An interpolated plan (plan.ts) is shown read-only until "Make key" or the
 * first edit turns it into the frame's own plan. Nothing here moves the rig
 * or touches the camera — "Go" does, explicitly.
 */
import type {TethrConfig} from '@tethr/vue3'
import type {ConfigName, ConfigType} from 'tethr'
import * as Tq from 'tweeq'
import {computed} from 'vue'

import TethrConfigInput from '@/components/TethrConfig.vue'
import {useCameraStore} from '@/stores/camera'
import {useProjectStore} from '@/stores/project'
import {useViewportStore} from '@/stores/viewport'
import {AXES, type AxesPosition,type Axis} from '@/utils/fluidnc'

import {workAxesToCameraPose} from '../kinematics'
import {type FramePlan, PLAN_CAMERA_CONFIG_NAMES, type PlanCameraConfigName} from '../plan'
import {useLedStore} from '../stores/led'
import {useRigStore} from '../stores/machines'
import {useRigWorkStore} from '../stores/rigWork'
import {useSequenceStore} from '../stores/sequence'

const project = useProjectStore()
const led = useLedStore()
const viewport = useViewportStore()
const camera = useCameraStore()
const rig = useRigStore()
const rigWork = useRigWorkStore()
const sequence = useSequenceStore()

const frame = computed(() => viewport.currentFrame)
const layer = computed(() => viewport.currentLayer)
const layerName = computed(() => project.layers[layer.value]?.name ?? `layer ${layer.value}`)

const effective = computed(() => sequence.effectivePlan(frame.value, layer.value))
const own = computed(() => sequence.planFor(frame.value, layer.value))
const isExplicit = computed(() => !!own.value)

const stateText = computed(() => {
	const e = effective.value
	if (!e) return 'no plan'
	return e.kind === 'interpolated' ? `interpolated ${e.from}→${e.to}` : 'key'
})

//------------------------------------------------------------------------------
// Editing: every change writes a whole plan back (setPlan), turning an
// interpolated / missing plan into the frame's own on the first edit.

function basePlan(): FramePlan {
	return {...(own.value ?? effective.value?.plan ?? {})}
}

function write(plan: FramePlan) {
	sequence.setPlan(frame.value, plan, layer.value)
}

/** Where the rig is now, in work coordinates (0 while it isn't connected). */
function rigNow(axis: Axis) {
	const machine = rig.connected ? rig.mpos[axis] : undefined
	return machine === undefined ? 0 : rigWork.axisToWork(axis, machine)
}

/** Start values for the axes when the plan has none: the rig now. */
function seedRig(): AxesPosition {
	const out: AxesPosition = {}
	for (const a of AXES) out[a] = rigNow(a)
	return out
}

/** The planned axes (work coordinates). */
const rigValues = computed<AxesPosition>(() => effective.value?.plan.rig ?? {})

/** What an axis field shows: the planned position, else where the rig is now. */
function shownAxis(axis: Axis) {
	return rigValues.value[axis] ?? rigNow(axis)
}

function setAxis(axis: Axis, value: number) {
	// The input writes back what it shows, quantized to its step: not an edit
	// (it would turn an interpolated plan into a key just by being selected).
	if (Math.abs(value - shownAxis(axis)) < 0.0005) return
	// Clamped here, on a real edit — not by the input (see the template).
	const [min, max] = axisLimits(axis)
	const clamped = Math.min(Math.max(value, min), max)
	const plan = basePlan()
	const rigAxes: AxesPosition = {...(plan.rig ?? seedRig()), [axis]: clamped}
	delete plan.camera
	write({...plan, rig: rigAxes})
}

/** Slider range in work coordinates (the travel limits are machine). */
function axisLimits(axis: Axis): [number, number] {
	const lim = project.addsub.rigLimits[axis]
	if (lim) return [rigWork.axisToWork(axis, lim[0]), rigWork.axisToWork(axis, lim[1])]
	return axis === 'a' || axis === 'b' || axis === 'c' ? [-180, 180] : [0, 1500]
}

// The six axes as two rows of three, like a transform: the unit is the
// row's, so the fields carry only the number.
const rigRows: {label: string; icon: string; axes: Axis[]; hint: string}[] = [
	{
		label: 'Position',
		icon: 'mdi:axis-arrow',
		axes: ['x', 'y', 'z'],
		hint: 'X · Y · Z — work coordinates, mm',
	},
	{
		label: 'Rotation',
		icon: 'mdi:rotate-orbit',
		axes: ['a', 'b', 'c'],
		hint: 'A · B · C (tilt · pan · roll) — work coordinates, degrees',
	},
]

/**
 * Where the entrance pupil is for the axes shown (world mm): what the picture
 * is taken from, as opposed to the head centre the axes place. Read-only —
 * the axes are what is stored.
 */
const pupilWorld = computed(() => {
	const axes: AxesPosition = {}
	for (const a of AXES) axes[a] = shownAxis(a)
	return workAxesToCameraPose(axes, project.addsub.calibration).position
})

const cameraValues = computed(() => (effective.value?.plan.cameraConfigs ?? {}) as Partial<ConfigType>)

/** The planned wall (a record file), shown by its hash. */
const plannedLed = computed(() => effective.value?.plan.led)
const plannedLedText = computed(() => {
	const f = plannedLed.value?.file
	if (!f) return ''
	return f.replace(/^.*\//, '').replace(/\.ledwall$/, '')
})

function clearLed() {
	const plan = basePlan()
	delete plan.led
	write(plan)
}

function setCameraConfig(name: PlanCameraConfigName, value: unknown) {
	const plan = basePlan()
	write({...plan, cameraConfigs: {...(plan.cameraConfigs ?? {}), [name]: value}})
}

function clearCameraConfig(name: PlanCameraConfigName) {
	const plan = basePlan()
	if (!plan.cameraConfigs) return
	const rest = {...plan.cameraConfigs}
	delete rest[name]
	write({...plan, cameraConfigs: Object.keys(rest).length ? rest : undefined})
}

/**
 * A TethrConfig-shaped view of one planned value: the live camera's option
 * list (so the drum / dropdown offer real choices) and a setter that edits
 * the plan instead of the camera.
 */
function planConfig(name: PlanCameraConfigName): TethrConfig<any> {
	const live = (camera as unknown as Record<string, TethrConfig<any> | undefined>)[name]
	const value = cameraValues.value[name] ?? null
	return {
		writable: true,
		value,
		target: value,
		option: live?.option,
		set: v => setCameraConfig(name, v),
	}
}

function hasOption(name: PlanCameraConfigName) {
	const live = (camera as unknown as Record<string, TethrConfig<any> | undefined>)[name]
	return !!live?.option
}

/** Free-text fallback while no camera is connected: numbers stay numbers. */
function setCameraConfigText(name: PlanCameraConfigName, text: string) {
	const t = text.trim()
	if (t === '') {
		clearCameraConfig(name)
		return
	}
	const n = Number(t)
	setCameraConfig(name, /^-?\d+(\.\d+)?$/.test(t) && Number.isFinite(n) ? n : t)
}

const cameraRows: {name: PlanCameraConfigName; label: string; icon: string}[] = [
	{name: 'aperture', label: 'Aperture', icon: 'mdi:camera-iris'},
	{name: 'shutterSpeed', label: 'Shutter', icon: 'mdi:camera-timer'},
	{name: 'iso', label: 'ISO', icon: 'mdi:film'},
	{name: 'focusDistance', label: 'Focus', icon: 'mdi:image-filter-center-focus-weak'},
]

//------------------------------------------------------------------------------
// Commands

async function run(fn: () => Promise<unknown>) {
	try {
		await fn()
	} catch (e) {
		alert(e instanceof Error ? e.message : String(e))
	}
}

function makeKey() {
	const e = effective.value
	if (!e || e.kind === 'explicit') return
	write({...e.plan})
}

const canGo = computed(
	() => !!effective.value && !sequence.running && !rig.busy && (rig.connected || !!camera.tethr)
)

// Keep the compile-time list and the rows in sync.
void (PLAN_CAMERA_CONFIG_NAMES satisfies readonly ConfigName[])
</script>

<template>
	<Tq.ParameterGroup name="addsub.plan" label="Plan" icon="mdi:map-marker-path">
		<template #headingRight>
			<span class="state tq-font-numeric" :class="{mute: !effective}">
				#{{ frame }} · {{ stateText }}
			</span>
		</template>

		<Tq.Parameter
			label="Frame"
			icon="mdi:film"
			:hint="{
				title: 'Selected cell',
				description: 'The plan edited here belongs to the selected timeline cell. Click a cell (or a planned empty one) to edit its plan.',
			}"
		>
			<div class="row">
				<span class="tq-font-numeric">{{ frame }}</span>
				<span class="mute">{{ layerName }}</span>
				<Tq.InputButton
					icon="mdi:crosshairs-gps"
					label="Go"
					:tooltip="{
						title: 'Go to plan',
						description: 'Move the rig to this pose and put these settings on the camera.',
					}"
					:disabled="!canGo"
					@click="run(() => sequence.goToPlan(frame, layer))"
				/>
			</div>
		</Tq.Parameter>

		<Tq.Parameter label="Plan" icon="mdi:map-marker-plus">
			<div class="controls">
				<Tq.InputButton
					label="From current"
					icon="mdi:content-save-outline"
					:tooltip="{
						title: 'Set plan from current',
						description: 'Record the rig\'s current axes and the camera\'s current settings.',
					}"
					:disabled="!rig.connected && !camera.tethr"
					@click="run(() => sequence.setPlanFromCurrent(frame, layer))"
				/>
				<Tq.InputButton
					v-if="effective?.kind === 'interpolated'"
					label="Make key"
					icon="mdi:key-variant"
					tooltip="Turn the interpolated values into this frame's own plan"
					@click="makeKey"
				/>
				<Tq.InputButton
					icon="mdi:close"
					subtle
					narrow
					tooltip="Clear this frame's plan"
					:disabled="!isExplicit"
					@click="sequence.setPlan(frame, null, layer)"
				/>
			</div>
		</Tq.Parameter>

		<!-- Rig axes: the travel limits give the slider its range. Editing an
		     interpolated plan makes it this frame's own (all six axes). -->
		<Tq.Parameter
			v-for="row in rigRows"
			:key="row.label"
			:label="row.label"
			:icon="row.icon"
			:hint="row.hint"
		>
			<Tq.InputGroup>
				<!-- The step is the stored resolution, not a drag increment: InputNumber
				     writes back the value quantized to it as soon as it shows one, so
				     a coarse step would round every plan that is merely selected.
				     It must not clamp either: it clamps (and writes back) a new value
				     against the range it had before, so a plan would be rewritten
				     whenever the work offset — the value and the range — changes. -->
				<Tq.InputNumber
					v-for="axis in row.axes"
					:key="axis"
					:modelValue="shownAxis(axis)"
					:min="axisLimits(axis)[0]"
					:max="axisLimits(axis)[1]"
					:clampMin="false"
					:clampMax="false"
					:precision="3"
					:step="0.001"
					:class="{unset: rigValues[axis] === undefined}"
					@update:modelValue="setAxis(axis, $event)"
				/>
			</Tq.InputGroup>
		</Tq.Parameter>

		<Tq.Parameter
			label="Pupil"
			icon="mdi:eye-outline"
			hint="Entrance pupil for the axes above — world coordinates, mm. Derived from the calibration's pupil offset; the axes are what is stored."
		>
			<div class="pupil tq-font-numeric" :class="{unset: !rigValues.x}">
				<span v-for="(v, i) in pupilWorld" :key="i">{{ v.toFixed(1) }}</span>
			</div>
		</Tq.Parameter>

		<Tq.Parameter
			label="LED"
			icon="mdi:led-strip-variant"
			hint="The wall for this frame: a recorded wall (led-wall/*.ledwall) put back pixel for pixel before the shot. Set from Houdini (Send Plans)."
		>
			<div class="row">
				<span class="tq-font-numeric" :class="{mute: !plannedLed}">{{ plannedLedText || '—' }}</span>
				<Tq.InputButton
					v-if="plannedLed"
					icon="mdi:lightbulb-on-outline"
					label="Show"
					tooltip="Put this wall on the LEDs now"
					:disabled="sequence.running"
					@click="run(() => led.showWallRecord(plannedLed!.file))"
				/>
				<Tq.InputButton
					v-if="plannedLed"
					icon="mdi:close"
					subtle
					narrow
					tooltip="Take the wall out of this frame's plan"
					@click="clearLed"
				/>
			</div>
		</Tq.Parameter>

		<!-- Camera settings: the connected camera's choices; free text without one. -->
		<Tq.Parameter v-for="row in cameraRows" :key="row.name" :label="row.label" :icon="row.icon">
			<div class="row">
				<TethrConfigInput
					v-if="hasOption(row.name)"
					:config="planConfig(row.name)"
					:name="row.name"
					:class="{unset: cameraValues[row.name] === undefined}"
				/>
				<Tq.InputString
					v-else
					:modelValue="cameraValues[row.name] === undefined ? '' : String(cameraValues[row.name])"
					font="numeric"
					placeholder="—"
					@update:modelValue="setCameraConfigText(row.name, $event)"
				/>
				<Tq.InputButton
					icon="mdi:close"
					subtle
					narrow
					tooltip="Leave this setting out of the plan"
					:disabled="cameraValues[row.name] === undefined"
					@click="clearCameraConfig(row.name)"
				/>
			</div>
		</Tq.Parameter>
	</Tq.ParameterGroup>
</template>

<style lang="stylus" scoped>
.state
	font-size 0.85em
	font-weight 600

.mute
	color var(--tq-color-text-mute)

.row
	display flex
	align-items center
	gap var(--tq-gap-control)

	> :first-child
		flex 1 1 0
		min-width 0

.controls
	display flex
	flex-wrap wrap
	gap var(--tq-gap-group)

.unset
	opacity 0.5

.pupil
	display grid
	grid-template-columns repeat(3, 1fr)
	gap var(--tq-gap-control)
	color var(--tq-color-text-mute)

	span
		text-align right
</style>
