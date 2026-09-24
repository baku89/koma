<script setup lang="ts">
import {useTweeq} from 'tweeq'
import {computed} from 'vue'

import {useProjectStore} from '@/stores/project'

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

const showSettings = Tq.config.ref('addsub.sequence.showSettings', false)

const addsub = computed(() => project.addsub)
const progress = computed(() => project.addsub.sequence)

const captureFrame = computed(() => project.captureShot.frame)
const previzFrame = computed(() => previz.frameFor(captureFrame.value))

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
			</div>
		</Tq.Parameter>
		<Tq.Parameter label="Replay" icon="mdi:replay" hint="Re-shoot the preview range (in → out) at the current k_base into a replay layer">
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
			<Tq.Parameter label="k_base" icon="mdi:layers" hint="Index of the lowest block on the mill">
				<div class="buttons">
					<Tq.InputNumber v-model="project.addsub.kBase" :min="0" :max="100" :step="1" :precision="0" />
					<Tq.InputButton label="Append Block" icon="mdi:plus-box" tooltip="k_base + 1 (after placing the next block underneath)" @click="sequence.appendBlock()" />
				</div>
			</Tq.Parameter>
			<Tq.Parameter label="Offset" icon="mdi:numeric" hint="previz frame = timeline frame + offset">
				<Tq.InputNumber v-model="project.addsub.previzFrameOffset" :step="1" :precision="0" />
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
			<Tq.Parameter label="Settle" icon="mdi:timer-sand" hint="Wait after the rig stops (ms)">
				<Tq.InputNumber v-model="project.addsub.settleMs" :min="0" :max="60000" :step="100" :precision="0" />
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
			<Tq.ParameterHeading>Calibration</Tq.ParameterHeading>
			<Tq.Parameter label="Pupil d" icon="mdi:eye" hint="Entrance pupil offset from the head's rotation centre (mm)">
				<Tq.InputNumber v-model="project.addsub.calibration.pupilOffset" :precision="2" />
			</Tq.Parameter>
			<Tq.Parameter label="Film origin" icon="mdi:axis-arrow" hint="World position of block A's bottom corner (k_base = 0)">
				<Tq.InputVec v-model="project.addsub.calibration.filmOriginWorld" />
			</Tq.Parameter>
			<Tq.Parameter label="Rig offset" icon="mdi:axis-arrow" hint="rig = world + offset">
				<Tq.InputVec v-model="project.addsub.calibration.rigOffset" />
			</Tq.Parameter>
			<Tq.Parameter label="Mill offset" icon="mdi:axis-arrow" hint="world = cycle(mill) + offset, at the shoot position">
				<Tq.InputVec v-model="project.addsub.calibration.millOffset" />
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
