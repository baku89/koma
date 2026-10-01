<script lang="ts" setup>
/**
 * The cut of the *selected* timeline cell (viewport.currentFrame /
 * currentLayer): which G-code it runs before it is shot (a file dropped on
 * the cell, else previz's), whether that has run and how long it took, and
 * the button that runs it now. While a cut streams, progress and the ETA
 * (cuts.ts, parser estimate × measured ratio) show here and in the title bar.
 */
import dateformat from 'dateformat'
import * as Tq from 'tweeq'
import {computed} from 'vue'

import {useProjectStore} from '@/stores/project'
import {useViewportStore} from '@/stores/viewport'

import {formatDuration, GCODE_EXTENSIONS, isGcodeFilename, totalMillTime} from '../cuts'
import {useMillStore} from '../stores/machines'
import {useSequenceStore} from '../stores/sequence'

const project = useProjectStore()
const viewport = useViewportStore()
const mill = useMillStore()
const sequence = useSequenceStore()

const frame = computed(() => viewport.currentFrame)
const layer = computed(() => viewport.currentLayer)
const layerName = computed(() => project.layers[layer.value]?.name ?? `layer ${layer.value}`)
const isCaptureFrame = computed(
	() => frame.value === project.captureShot.frame && layer.value === project.captureShot.layer
)

const gcode = computed(() => sequence.gcodeFor(frame.value, layer.value))
const run = computed(() => gcode.value?.cut?.run ?? null)
const done = computed(() => {
	const g = gcode.value
	return !!g && !!g.cut?.run?.done && g.cut.file === g.path
})

const estimateText = computed(() => {
	const g = gcode.value
	const sec = g?.cut?.estimatedSec
	if (!sec) return null
	return `~${formatDuration(sec * 1000)}`
})

const runText = computed(() => {
	const r = run.value
	if (!r) return 'not cut yet'
	const when = dateformat(r.startedAt, 'mmm d HH:MM')
	if (r.done) return `done in ${formatDuration(r.durationMs)} · ${when}`
	return `stopped at ${r.linesSent}/${r.total} after ${formatDuration(r.durationMs)} · ${when}`
})

// What "Set G54" would send before the cut (null while it is off).
const workOffsetLine = computed(() => sequence.cutWorkOffsetLine())

const progress = computed(() => sequence.cutProgress)
const cuttingThis = computed(
	() => !!progress.value && progress.value.frame === frame.value && progress.value.layer === layer.value
)

const canCut = computed(
	() => !!gcode.value && mill.connected && !sequence.running && !mill.busy
)

const stateText = computed(() => {
	if (cuttingThis.value) return 'cutting'
	if (!gcode.value) return 'no G-code'
	return done.value ? 'cut' : 'to cut'
})

const millTimeText = computed(() => formatDuration(totalMillTime(project)))

async function cut() {
	try {
		await sequence.cutFrame(frame.value, layer.value)
	} catch (e) {
		alert(e instanceof Error ? e.message : String(e))
	}
}

// Attach via a picker (the cell also takes a drop). Several files go on
// consecutive frames in name order, like a drop.
async function attach() {
	let files: File[] = []
	const picker = (window as any).showOpenFilePicker as
		| ((opts: unknown) => Promise<FileSystemFileHandle[]>)
		| undefined
	try {
		if (picker) {
			const handles = await picker({
				multiple: true,
				types: [{description: 'G-code', accept: {'text/plain': GCODE_EXTENSIONS}}],
			})
			files = await Promise.all(handles.map(h => h.getFile()))
		} else {
			files = await pickWithInput()
		}
	} catch {
		return // cancelled
	}
	files = files
		.filter(f => isGcodeFilename(f.name))
		.sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true}))
	try {
		for (const [i, file] of files.entries()) {
			await sequence.attachCutFile(frame.value + i, layer.value, file)
		}
	} catch (e) {
		alert(e instanceof Error ? e.message : String(e))
	}
}

function pickWithInput(): Promise<File[]> {
	return new Promise(resolve => {
		const input = document.createElement('input')
		input.type = 'file'
		input.multiple = true
		input.accept = GCODE_EXTENSIONS.join(',')
		input.onchange = () => resolve(Array.from(input.files ?? []))
		input.oncancel = () => resolve([])
		input.click()
	})
}
</script>

<template>
	<Tq.ParameterGroup name="addsub.cut" label="Cut" icon="mdi:saw-blade">
		<template #headingRight>
			<span class="state tq-font-numeric" :class="{mute: !gcode, todo: gcode && !done && !cuttingThis}">
				#{{ frame }} · {{ stateText }}
			</span>
		</template>

		<Tq.Parameter
			label="Frame"
			icon="mdi:film"
			:hint="{
				title: 'Selected cell',
				description: 'The cut shown here belongs to the selected timeline cell. Drop .nc / .gcode files on a cell to attach them (several files land on consecutive frames).',
			}"
		>
			<div class="row">
				<span class="tq-font-numeric">{{ frame }}</span>
				<span class="mute">{{ layerName }}</span>
				<span v-if="isCaptureFrame" class="mute">(capture frame)</span>
			</div>
		</Tq.Parameter>

		<Tq.Parameter label="G-code" icon="mdi:file-code-outline">
			<div class="row">
				<span v-if="gcode" class="name" :title="gcode.path">{{ gcode.name }}</span>
				<span v-else class="mute">none</span>
				<Tq.InputButton
					icon="mdi:file-plus-outline"
					subtle
					narrow
					tooltip="Attach a G-code file to this frame (or drop it on the cell)"
					@click="attach"
				/>
				<Tq.InputButton
					v-if="gcode?.source === 'file'"
					icon="mdi:close"
					subtle
					narrow
					tooltip="Detach the file (previz's cut applies again, if any)"
					:disabled="cuttingThis"
					@click="sequence.removeCut(frame, layer)"
				/>
			</div>
			<div v-if="gcode" class="row mute small">
				<span>{{ gcode.source === 'file' ? 'dropped' : 'previz' }}</span>
				<span v-if="gcode.cut?.lines" class="tq-font-numeric">{{ gcode.cut.lines }} lines</span>
				<span v-if="estimateText" class="tq-font-numeric">{{ estimateText }}</span>
			</div>
		</Tq.Parameter>

		<Tq.Parameter v-if="gcode" label="Run" icon="mdi:history">
			<div class="row">
				<Tq.Icon
					:icon="done ? 'mdi:check-circle' : run ? 'mdi:alert-circle-outline' : 'mdi:circle-outline'"
					:class="{ok: done, bad: run && !done}"
				/>
				<span class="small" :class="{mute: !run}">{{ runText }}</span>
				<Tq.InputButton
					v-if="run"
					icon="mdi:undo-variant"
					subtle
					narrow
					tooltip="Forget this run (the frame counts as not cut)"
					:disabled="cuttingThis"
					@click="sequence.clearCutRun(frame, layer)"
				/>
			</div>
		</Tq.Parameter>

		<Tq.Parameter label="Cut" icon="mdi:play" hint="Run this frame's G-code on the mill now (G54 is pointed at the film origin first). Stop feed-holds the mill.">
			<div class="row">
				<Tq.InputButton
					v-if="!cuttingThis"
					label="Cut now"
					icon="mdi:saw-blade"
					:disabled="!canCut"
					@click="cut"
				/>
				<Tq.InputButton
					v-else
					label="Stop"
					icon="mdi:stop"
					@click="sequence.stop()"
				/>
			</div>
			<div v-if="cuttingThis && progress" class="progress">
				<div class="bar"><div class="fill" :style="{width: `${progress.fraction * 100}%`}" /></div>
				<div class="row small tq-font-numeric">
					<span>{{ progress.sent }} / {{ progress.total }}</span>
					<span>{{ formatDuration(progress.elapsedMs) }}</span>
					<span v-if="progress.remainingMs !== null" class="mute">−{{ formatDuration(progress.remainingMs) }}</span>
				</div>
			</div>
		</Tq.Parameter>

		<Tq.Parameter label="Require" icon="mdi:shield-check-outline" hint="Refuse the shutter while the capture frame's G-code has not run to the end (shoot condition). Turn off for dry runs without the mill.">
			<Tq.InputSwitch v-model="project.addsub.requireCut" />
		</Tq.Parameter>

		<Tq.Parameter label="Set G54" icon="mdi:axis-arrow" hint="Before each cut, overwrite the mill's G54 origin with the film origin (G10 L2 P1, from Mill offset and Film lift). Off: the G-code runs in the work zero set on the machine, like any sender. Turn on only after Mill offset is calibrated.">
			<div class="row">
				<Tq.InputSwitch v-model="project.addsub.cutSetsWorkOffset" />
				<span v-if="workOffsetLine" class="mute small tq-font-numeric">{{ workOffsetLine }}</span>
			</div>
		</Tq.Parameter>

		<Tq.Parameter label="Mill time" icon="mdi:timer-outline" hint="Total time the mill has spent on this project's recorded cuts">
			<span class="tq-font-numeric">{{ millTimeText }}</span>
		</Tq.Parameter>
	</Tq.ParameterGroup>
</template>

<style lang="stylus" scoped>
.row
	display flex
	align-items center
	gap var(--tq-gap-related)
	min-height var(--tq-input-height)
	flex-wrap wrap

.small
	font-size 0.85em

.mute
	color var(--tq-color-text-mute)

.state
	font-size 0.85em
	color var(--tq-color-text-mute)

	&.todo
		color #e0801a

.name
	overflow hidden
	text-overflow ellipsis
	white-space nowrap
	max-width 12em

.ok
	color var(--tq-color-accent)

.bad
	color var(--tq-color-rec)

.progress
	display flex
	flex-direction column
	gap 2px

	.bar
		height 4px
		border-radius 2px
		background var(--tq-color-input)
		overflow hidden

		.fill
			height 100%
			background var(--tq-color-accent)
			transition width 0.3s linear
</style>
