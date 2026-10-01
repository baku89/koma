<script setup lang="ts">
import {useTweeq} from 'tweeq'
import {computed} from 'vue'

import {useCameraStore} from '@/stores/camera'
import {useProjectStore} from '@/stores/project'

import {formatPlan} from '../plan'
import {
	REPLAY_STEPS,
	SEQUENCE_STEP_LABELS,
	SEQUENCE_STEPS,
	type SequenceStep,
} from '../projectData'
import {useMillStore, useRigStore} from '../stores/machines'
import {usePrevizStore} from '../stores/previz'
import {useSequenceStore} from '../stores/sequence'

const Tq = useTweeq()
const project = useProjectStore()
const sequence = useSequenceStore()
const previz = usePrevizStore()
const mill = useMillStore()
const rig = useRigStore()
const camera = useCameraStore()

const showSettings = Tq.config.ref('addsub.sequence.showSettings', false)

const addsub = computed(() => project.addsub)
const progress = computed(() => project.addsub.sequence)

const captureFrame = computed(() => project.captureShot.frame)
const parkLayers = computed(() => project.layers.filter(l => !l.deleted))
const previzFrame = computed(() => previz.frameFor(captureFrame.value))
const plan = computed(() => sequence.effectivePlan(captureFrame.value))

const planText = computed(() => {
	const p = plan.value
	if (!p) return null
	const text = formatPlan(p.plan)
	return p.kind === 'interpolated' ? `~ ${text} (${p.from}→${p.to})` : text
})

const canGoToPlan = computed(
	() => !!plan.value && !sequence.running && !rig.busy && (rig.connected || !!camera.tethr)
)

async function setPlanFromCurrent() {
	try {
		await sequence.setPlanFromCurrent(captureFrame.value, project.captureShot.layer)
	} catch (e) {
		alert(e instanceof Error ? e.message : String(e))
	}
}

async function goToPlan() {
	try {
		await sequence.goToPlan()
	} catch (e) {
		alert(e instanceof Error ? e.message : String(e))
	}
}

const statusText = computed(() => {
	if (sequence.running) return sequence.message ?? 'Running'
	const p = progress.value
	if (!p) return 'Idle'
	switch (p.status) {
		case 'done':
			return p.mode === 'replay' ? 'Replay done' : `Frame ${p.frame} done`
		case 'stopped':
			return `Stopped at ${SEQUENCE_STEP_LABELS[p.step]} (frame ${p.frame})`
		case 'error':
			return `Error at ${SEQUENCE_STEP_LABELS[p.step]}: ${p.error ?? ''}`
		case 'paused':
			return `Paused (frame ${p.frame})`
		case 'running':
			return p.mode === 'replay'
				? `Replaying ${p.frame} of ${p.range?.[0]}–${p.range?.[1]}`
				: `Frame ${p.frame}: ${SEQUENCE_STEP_LABELS[p.step]}`
		default:
			return `Interrupted at ${SEQUENCE_STEP_LABELS[p.step]} (frame ${p.frame})`
	}
})

const activeSteps = computed(() =>
	progress.value?.mode === 'replay' ? REPLAY_STEPS : SEQUENCE_STEPS
)

const canResume = computed(
	() => !sequence.running && !!progress.value && progress.value.status !== 'done'
)

function stepState(step: SequenceStep): 'done' | 'current' | 'todo' {
	const p = progress.value
	if (!p) return 'todo'
	if (p.done.includes(step)) return 'done'
	if (p.step === step) return 'current'
	return 'todo'
}

const parkLayerId = computed<string | null>({
	get: () => project.addsub.parkLayerId,
	set: v => (project.addsub.parkLayerId = v),
})

const resumeStep = computed<SequenceStep>({
	get: () => progress.value?.step ?? SEQUENCE_STEPS[0],
	set: v => {
		if (project.addsub.sequence) project.addsub.sequence = {...project.addsub.sequence, step: v}
	},
})

function setShootFromMill() {
	const {x, y} = mill.mpos
	if (x === undefined) return
	project.addsub.shootPosition = addsub.value.shootPosition.y === undefined ? {x} : {x, y}
}

/**
 * Calibration shortcut: with the tool tip touching the film origin (block A's
 * bottom corner, table at the shoot position), solve millOffset so that
 * filmOriginMill(filmLift) equals the current machine position:
 *   world = cycle(mill) + t  ⇒  t = filmOriginWorld + [0, lift, 0] − cycle(mpos)
 */
function setMillOffsetFromHere() {
	const m = mill.mpos
	if (m.x === undefined || m.y === undefined || m.z === undefined) return
	const {filmOriginWorld} = project.addsub.calibration
	const lift = project.addsub.filmLift
	const cycled = [m.y, m.z, m.x]
	project.addsub.calibration.millOffset = [
		filmOriginWorld[0] - cycled[0],
		filmOriginWorld[1] + lift - cycled[1],
		filmOriginWorld[2] - cycled[2],
	]
}

/**
 * The other way round, after gluing a block underneath: with millOffset
 * already calibrated and the tool tip touching the joint plane (where the
 * film origin is now), measure the lift instead of trusting the block's
 * nominal height. Absorbs glue lines and cutting tolerances.
 *   world Y = cycle(mpos).y + t.y = filmOriginWorld.y + lift
 */
function setFilmLiftFromHere() {
	const m = mill.mpos
	if (m.z === undefined) return
	const {filmOriginWorld, millOffset} = project.addsub.calibration
	project.addsub.filmLift = m.z + millOffset[1] - filmOriginWorld[1]
}

async function appendBlock() {
	const result = await Tq.modal.prompt(
		{height: project.addsub.blockHeight},
		{height: {type: 'number', min: 0, max: 500, step: 1, label: 'Block height (mm)'}},
		{title: 'Append Block'}
	)
	if (!result) return
	sequence.appendBlock(result.height)
}

function setParkFromRig() {
	const m = rig.mpos
	if (m.x === undefined) return
	project.addsub.parkPose = {x: m.x, y: m.y, z: m.z, a: m.a, b: m.b, c: m.c}
}
</script>

<template>
	<Tq.ParameterGroup name="addsub.sequence" label="Shot Sequence" icon="mdi:play-box-multiple">
		<template #headingRight>
			<button class="toggle" @click="showSettings = !showSettings">
				{{ showSettings ? 'Hide Settings' : 'Settings' }}
			</button>
		</template>

		<Tq.Parameter label="Status" icon="mdi:information-outline">
			<span class="status" :class="progress?.status">{{ statusText }}</span>
		</Tq.Parameter>

		<Tq.Parameter label="Frame" icon="mdi:film" hint="Capture frame → previz frame">
			<span class="tq-font-numeric">
				{{ captureFrame }} → {{ captureFrame + addsub.previzFrameOffset }}
				<span class="mute">
					{{
						previzFrame
							? [previzFrame.pose ? 'pose' : '', previzFrame.gcode ? 'gcode' : '', previzFrame.led ? 'led' : '']
									.filter(Boolean)
									.join(' · ') || 'no data'
							: previz.available
								? 'not in previz'
								: 'no previz/ folder'
					}}
				</span>
			</span>
		</Tq.Parameter>

		<Tq.Parameter
			label="Plan"
			icon="mdi:map-marker-path"
			:hint="{
				title: 'Planned rig pose for the capture frame',
				description: 'Seeking never moves the rig; only Go or the sequence does.',
			}"
		>
			<div class="plan">
				<span class="tq-font-numeric plan-text" :class="{mute: !planText}">
					{{ planText ?? 'none' }}
				</span>
				<Tq.InputButton
					icon="mdi:crosshairs-gps"
					label="Go"
					:tooltip="{
						title: 'Go to plan',
						description: 'Move the rig to the planned pose (at the rig feed, after the limits check) and put the planned settings on the camera.',
					}"
					:disabled="!canGoToPlan"
					@click="goToPlan"
				/>
				<Tq.InputButton
					icon="mdi:content-save-outline"
					subtle
					narrow
					:tooltip="{
						title: 'Set plan from current',
						description: 'Record the rig\'s current axes and the camera\'s current settings as this frame\'s plan.',
					}"
					:disabled="!rig.connected && !camera.tethr"
					@click="setPlanFromCurrent"
				/>
				<Tq.InputButton
					icon="mdi:close"
					subtle
					narrow
					tooltip="Clear this frame's plan"
					:disabled="plan?.kind !== 'explicit'"
					@click="sequence.setPlan(captureFrame, null)"
				/>
			</div>
		</Tq.Parameter>

		<li class="steps">
			<span v-for="step in activeSteps" :key="step" class="step" :class="stepState(step)">
				<Tq.Icon
					:icon="
						stepState(step) === 'done'
							? 'mdi:check-circle'
							: stepState(step) === 'current'
								? sequence.running
									? 'mdi:progress-clock'
									: 'mdi:pause-circle-outline'
								: 'mdi:circle-outline'
					"
				/>
				{{ SEQUENCE_STEP_LABELS[step] }}
			</span>
		</li>

		<Tq.Parameter label="Run" icon="mdi:play">
			<div class="buttons">
				<Tq.InputButton
					label="One Frame"
					icon="mdi:play"
					:disabled="sequence.running"
					@click="sequence.start({frame: captureFrame})"
				/>
				<Tq.InputButton
					label="Continuous"
					icon="mdi:play-circle"
					:disabled="sequence.running"
					@click="sequence.start({frame: captureFrame, continuous: true})"
				/>
				<Tq.InputButton
					:label="`In → Out (${project.previewRange[0]}–${project.previewRange[1]})`"
					icon="mdi:ray-start-end"
					:tooltip="{
						title: 'Shoot the preview range',
						description: 'Run the sequence on every frame from the in-point to the out-point, then stop. Frames that already have a shot are re-shot (the old shot goes to the trash).',
					}"
					:disabled="sequence.running"
					@click="sequence.startRange()"
				/>
			</div>
		</Tq.Parameter>
		<Tq.Parameter label="Replay" icon="mdi:replay" hint="Re-shoot the preview range (in → out) at the current film lift into a replay layer">
			<Tq.InputButton
				:label="`In → Out (${project.previewRange[0]}–${project.previewRange[1]})`"
				icon="mdi:replay"
				:disabled="sequence.running"
				@click="sequence.startReplay()"
			/>
		</Tq.Parameter>
		<Tq.Parameter label="Control" icon="mdi:stop">
			<div class="buttons">
				<Tq.InputButton
					label="Stop"
					icon="mdi:stop"
					:disabled="!sequence.running"
					@click="sequence.stop()"
				/>
				<Tq.InputButton
					label="Finish Frame"
					icon="mdi:pause"
					:disabled="!sequence.running || !sequence.continuous"
					tooltip="Finish the current frame, then stop"
					@click="sequence.pauseAfterFrame()"
				/>
			</div>
		</Tq.Parameter>
		<Tq.Parameter v-if="canResume" label="Resume" icon="mdi:restart" hint="Resume the interrupted frame from a step">
			<div class="buttons">
				<Tq.InputDropdown
					v-model="resumeStep"
					:options="[...activeSteps]"
					:labels="activeSteps.map(s => SEQUENCE_STEP_LABELS[s])"
				/>
				<Tq.InputButton label="Resume" icon="mdi:restart" @click="sequence.resume(resumeStep)" />
				<Tq.InputButton icon="mdi:close" subtle narrow tooltip="Discard progress" @click="sequence.clearProgress()" />
			</div>
		</Tq.Parameter>

		<li v-if="sequence.warnings.length" class="warnings">
			<div v-for="(w, i) in sequence.warnings" :key="i">⚠ {{ w }}</div>
		</li>

		<template v-if="showSettings">
			<Tq.ParameterHeading>Blocks</Tq.ParameterHeading>
			<Tq.Parameter label="Film lift" icon="mdi:layers" hint="How far the film frame has risen (mm): the summed height of the blocks glued under block A">
				<div class="buttons">
					<Tq.InputNumber v-model="project.addsub.filmLift" :min="0" :max="2000" :precision="2" />
					<Tq.InputButton
						icon="mdi:crosshairs-gps"
						subtle
						narrow
						tooltip="Tool tip is on the joint plane (the film origin) now → measure the lift"
						:disabled="!mill.connected"
						@click="setFilmLiftFromHere"
					/>
					<Tq.InputButton label="Append Block…" icon="mdi:plus-box" tooltip="A block was glued underneath: add its height to the lift" @click="appendBlock" />
				</div>
			</Tq.Parameter>
			<Tq.Parameter label="Offset" icon="mdi:numeric" hint="previz frame = timeline frame + offset">
				<Tq.InputNumber v-model="project.addsub.previzFrameOffset" :step="1" :precision="0" />
			</Tq.Parameter>
			<Tq.Parameter
				label="Plan tolerance"
				icon="mdi:target-variant"
				:hint="{
					title: 'Plan tolerance',
					description: 'How far the rig may be from the planned pose and still pass the shoot condition: mm for X/Y/Z, degrees for A/B/C.',
				}"
			>
				<Tq.InputGroup>
					<Tq.InputNumber v-model="project.addsub.planTolerance.linear" :min="0" :max="50" :precision="2" suffix=" mm" />
					<Tq.InputNumber v-model="project.addsub.planTolerance.rotary" :min="0" :max="45" :precision="2" suffix=" °" />
				</Tq.InputGroup>
			</Tq.Parameter>

			<Tq.Parameter
				label="Auto move"
				icon="mdi:camera-marker-outline"
				:hint="{
					title: 'Auto move',
					description: 'After a shot, the rig moves by itself to the next frame\'s plan if that is less than this far away (straight line in X/Y/Z). Further than that it stays put. 0 = never.',
				}"
			>
				<Tq.InputNumber v-model="project.addsub.autoMoveMaxDistance" :min="0" :max="1000" :precision="0" suffix=" mm" />
			</Tq.Parameter>

			<Tq.ParameterHeading>Mill</Tq.ParameterHeading>
			<Tq.Parameter label="Shoot X" icon="mdi:axis-x-arrow" hint="Table X (machine coords) for shooting">
				<div class="buttons">
					<Tq.InputNumber v-model="project.addsub.shootPosition.x" :precision="3" />
					<Tq.InputButton icon="mdi:crosshairs-gps" subtle narrow tooltip="Set from current mill position" :disabled="!mill.connected" @click="setShootFromMill" />
				</div>
			</Tq.Parameter>
			<Tq.Parameter label="Feed" icon="mdi:speedometer" hint="Extend/retract feed (mm/min)">
				<Tq.InputNumber v-model="project.addsub.millFeed" :min="1" :max="5000" />
			</Tq.Parameter>

			<Tq.ParameterHeading>Rig</Tq.ParameterHeading>
			<Tq.Parameter label="Feed" icon="mdi:speedometer" hint="Rig move feed (mm/min)">
				<Tq.InputNumber v-model="project.addsub.rigFeed" :min="1" :max="20000" />
			</Tq.Parameter>
			<Tq.Parameter label="Settle" icon="mdi:timer-sand" hint="Wait after the rig stops (ms), always in full">
				<Tq.InputNumber v-model="project.addsub.settleMs" :min="0" :max="60000" :step="100" :precision="0" />
			</Tq.Parameter>
			<Tq.Parameter
				label="Until Still"
				icon="mdi:vibrate-off"
				:hint="{
					title: 'Wait until the live view is still',
					description: 'After the settle time, keep waiting while the live view moves more than it did before the rig moved — up to the limit (ms), then shoot anyway.',
				}"
			>
				<div class="buttons">
					<Tq.InputCheckbox v-model="project.addsub.settleStill" />
					<Tq.InputNumber
						v-model="project.addsub.settleMaxMs"
						:min="0"
						:max="120000"
						:step="1000"
						:precision="0"
						:disabled="!project.addsub.settleStill"
					/>
				</div>
			</Tq.Parameter>
			<Tq.Parameter label="Park" icon="mdi:parking" hint="Reference pose for park-frame shots">
				<div class="buttons">
					<span class="mute tq-font-numeric">
						{{ project.addsub.parkPose ? `X${project.addsub.parkPose.x?.toFixed(1)} Y${project.addsub.parkPose.y?.toFixed(1)} Z${project.addsub.parkPose.z?.toFixed(1)}` : 'not set' }}
					</span>
					<Tq.InputButton icon="mdi:crosshairs-gps" subtle narrow tooltip="Set from current rig position" :disabled="!rig.connected" @click="setParkFromRig" />
					<Tq.InputButton icon="mdi:close" subtle narrow tooltip="Clear" @click="project.addsub.parkPose = null" />
				</div>
			</Tq.Parameter>
			<Tq.Parameter label="Park shot" icon="mdi:camera-outline" hint="Take a park reference shot every frame">
				<Tq.InputSwitch v-model="project.addsub.takeParkShot" />
			</Tq.Parameter>
			<Tq.Parameter label="Park layer" icon="mdi:layers-outline" hint="Layer the park reference shots go to">
				<Tq.InputDropdown
					v-model="parkLayerId"
					:options="[null, ...parkLayers.map(l => l.id)]"
					:labels="['(create “Park”)', ...parkLayers.map(l => l.name)]"
				/>
			</Tq.Parameter>
			<Tq.ParameterHeading>Calibration</Tq.ParameterHeading>
			<Tq.Parameter label="Pupil d" icon="mdi:eye" hint="Entrance pupil offset from the head's rotation centre (mm)">
				<Tq.InputNumber v-model="project.addsub.calibration.pupilOffset" :precision="2" />
			</Tq.Parameter>
			<Tq.Parameter label="Film origin" icon="mdi:axis-arrow" hint="World position of block A's bottom corner before any block was added (lift = 0)">
				<Tq.InputVec v-model="project.addsub.calibration.filmOriginWorld" />
			</Tq.Parameter>
			<Tq.Parameter label="Rig offset" icon="mdi:axis-arrow" hint="rig = world + offset">
				<Tq.InputVec v-model="project.addsub.calibration.rigOffset" />
			</Tq.Parameter>
			<Tq.Parameter label="Mill offset" icon="mdi:axis-arrow" hint="world = cycle(mill) + offset, at the shoot position">
				<div class="buttons">
					<Tq.InputVec v-model="project.addsub.calibration.millOffset" />
					<Tq.InputButton
						icon="mdi:crosshairs-gps"
						subtle
						narrow
						tooltip="Tool tip is at the film origin now → solve the offset"
						:disabled="!mill.connected"
						@click="setMillOffsetFromHere"
					/>
				</div>
			</Tq.Parameter>
			<Tq.Parameter label="LED optional" icon="mdi:led-strip" hint="Skip the LED step when the wall isn't connected">
				<Tq.InputSwitch v-model="project.addsub.ledOptional" />
			</Tq.Parameter>
		</template>
	</Tq.ParameterGroup>
</template>

<style lang="stylus" scoped>
.toggle
	background var(--tq-color-input)
	height var(--tq-input-height)
	padding 0 1em
	border-radius 9999px

	&:hover
		background var(--tq-color-input-hover)

.status
	font-size 0.9em

	&.error
		color var(--tq-color-error, #e5484d)

	&.stopped
		color orange

.mute
	color var(--tq-color-text-mute)
	font-size 0.85em

.plan
	display flex
	align-items center
	gap var(--tq-gap-control)

.plan-text
	flex 1 1 0
	min-width 0
	overflow hidden
	text-overflow ellipsis
	white-space nowrap

.steps
	grid-column 1 / 3
	list-style none
	display flex
	flex-wrap wrap
	gap var(--tq-gap-group)
	padding 0 0 var(--tq-gap-group) var(--tq-gap-section)
	font-size 0.8em

.step
	display inline-flex
	align-items center
	gap 0.25em
	color var(--tq-color-text-mute)

	&.done
		color var(--tq-color-text)

	&.current
		color var(--tq-color-accent)

.buttons
	display flex
	flex-wrap wrap
	align-items center
	gap var(--tq-gap-group)

	> .TqInputNumber, > .TqInputDropdown
		flex 1 1 6em
		min-width 0

.warnings
	grid-column 1 / 3
	list-style none
	font-size 0.8em
	color orange
	padding 0 0 var(--tq-gap-group) var(--tq-gap-section)
</style>
