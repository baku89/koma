<script lang="ts" setup>
/**
 * Lens: the camera's focus in millimetres (through the lens table, lens.ts),
 * auto focus on a work-coordinate target, and the measurements the table is
 * fitted from. Lives under Camera Control; the generic panel's normalised
 * focus becomes read-only once a table exists.
 */
import * as Tq from 'tweeq'
import {computed, ref} from 'vue'

import {useCameraStore} from '@/stores/camera'
import {useProjectStore} from '@/stores/project'

import {FOCUS_MM_RANGE, FOCUS_MODE_LABELS, FOCUS_MODES} from '../lens'
import {useLensStore} from '../stores/lens'
import {useRigStore} from '../stores/machines'

const project = useProjectStore()
const camera = useCameraStore()
const rig = useRigStore()
const lens = useLensStore()

const lastError = ref<string | null>(null)

const modeLabels = FOCUS_MODES.map(m => FOCUS_MODE_LABELS[m])
const modeIcons = ['mdi:numeric', 'mdi:ruler', 'mdi:target']

function report(e: unknown) {
	lastError.value = e instanceof Error ? e.message : String(e)
}

//------------------------------------------------------------------------------
// Focus in mm

const focusMm = computed(() => lens.focusMm ?? 0)
const focusRange = FOCUS_MM_RANGE

async function onFocusMm(mm: number) {
	if (lens.focusMm !== null && Math.abs(mm - lens.focusMm) < 0.05) return
	try {
		lastError.value = null
		await lens.setFocusMm(mm)
	} catch (e) {
		report(e)
	}
}

const focusText = computed(() => {
	const n = lens.focusNormalized
	if (n === null) return camera.tethr ? 'focus unknown' : 'no camera'
	const cur = lens.current
	const extra = cur ? ` · f ${cur.focal.toFixed(1)} mm · pupil ${cur.pupil.toFixed(0)} mm` : ''
	return `normalized ${n.toFixed(3)}${lens.focusWritable ? '' : ' (read-only)'}${extra}`
})

//------------------------------------------------------------------------------
// Auto focus

const autoText = computed(() => {
	if (!lens.hasTable) return 'needs a lens table'
	if (!rig.connected) return 'Box Rig not connected'
	const d = lens.targetDistance
	if (d === null) return 'waiting for the rig position'
	const n = lens.autoNormalized
	const out = lens.autoOutOfRange ? ' — outside the table' : ''
	return `target ${d.toFixed(1)} mm → ${n === null ? '—' : n.toFixed(3)}${out}`
})

function copyAimTarget() {
	project.addsub.focus.target = [...project.addsub.aimTarget] as [number, number, number]
}

//------------------------------------------------------------------------------
// Measurements

const sampleText = computed(() => {
	const n = lens.calibration.samples.length
	if (n === 0) return 'no measurements'
	const settings = new Set(lens.calibration.samples.map(s => s.focus)).size
	return `${n} readings · ${settings} focus settings · ${lens.table.length} rows fitted`
})

async function pasteSheet() {
	try {
		lastError.value = null
		const text = await navigator.clipboard.readText()
		lens.importSheet(text)
	} catch (e) {
		report(e)
	}
}

async function openSheet() {
	try {
		lastError.value = null
		const [handle] = await (window as any).showOpenFilePicker({
			types: [
				{
					description: 'Sheet (TSV / CSV)',
					accept: {'text/plain': ['.tsv', '.csv', '.txt']},
				},
			],
		})
		const file: File = await handle.getFile()
		lens.importSheet(await file.text())
	} catch (e) {
		if (e instanceof DOMException && e.name === 'AbortError') return
		report(e)
	}
}

function clearSheet() {
	if (!confirm('Remove all lens measurements from this project?')) return
	lens.clearSamples()
}

const tableLines = computed(() =>
	lens.table.map(
		r =>
			`${r.focus.toFixed(3)}  ${r.distance.toFixed(1).padStart(7)} mm  f ${r.focal.toFixed(1).padStart(6)}  pupil ${r.pupil.toFixed(0).padStart(4)}${r.pupilSource === 'assumed' ? ' *' : ''}`
	)
)
</script>

<template>
	<Tq.ParameterGroup name="addsub.lens" label="Lens" icon="tabler:frustum">
		<Tq.Parameter
			label="Focus mode"
			icon="mdi:image-filter-center-focus-weak"
			hint="Normalized: the camera's own 0–1 position, typed in Camera Control. Distance: millimetres from the head's rotation centre, through the lens table. Target: auto focus — kept on the target point from wherever the rig is (the plan's focus is ignored)."
		>
			<Tq.InputRadio
				v-model="lens.mode"
				:options="[...FOCUS_MODES]"
				:labels="modeLabels"
				:tooltips="modeLabels"
				:icons="modeIcons"
			/>
		</Tq.Parameter>

		<Tq.Parameter
			label="Distance"
			icon="mdi:ruler"
			hint="Where the lens is focused, mm from the head's rotation centre along the optical axis. Editable in Distance mode; sends the matching normalised position to the camera."
		>
			<div class="row">
				<Tq.InputNumber
					:modelValue="focusMm"
					:min="focusRange[0]"
					:max="focusRange[1]"
					:step="0.1"
					suffix=" mm"
					:disabled="lens.mode !== 'distance' || !lens.hasTable || !lens.focusWritable"
					@update:modelValue="onFocusMm"
				/>
			</div>
			<div class="note">{{ focusText }}</div>
		</Tq.Parameter>

		<Tq.Parameter
			label="Target"
			icon="mdi:target"
			hint="The point to keep in focus in Target mode, Box Rig work coordinates (mm)."
		>
			<div class="row">
				<Tq.InputVec v-model="project.addsub.focus.target" :step="1" />
				<Tq.InputButton
					icon="mdi:crosshairs"
					subtle
					narrow
					tooltip="Use the last “Aim Camera at Work Point” target"
					@click="copyAimTarget"
				/>
			</div>
			<div v-if="lens.mode === 'target'" class="note">{{ autoText }}</div>
		</Tq.Parameter>

		<Tq.Parameter v-if="lastError" label="Error" icon="mdi:alert-circle-outline">
			<div class="error">
				<span class="error-text">{{ lastError }}</span>
				<Tq.InputButton icon="mdi:close" subtle narrow @click="lastError = null" />
			</div>
		</Tq.Parameter>

		<Tq.ParameterHeading>Lens table</Tq.ParameterHeading>
		<Tq.Parameter
			label="Measurements"
			icon="mdi:table"
			hint="Paste the sheet (distance · normalized focus · half width [· half width at +far step, when not measuring from the pupil]) from the clipboard, or open a TSV / CSV. Replaces the previous measurements."
		>
			<div class="row">
				<Tq.InputButton label="Paste" icon="mdi:content-paste" @click="pasteSheet" />
				<Tq.InputButton label="Open…" icon="mdi:folder-open" @click="openSheet" />
				<Tq.InputButton
					icon="mdi:delete"
					subtle
					narrow
					tooltip="Remove all measurements"
					:disabled="lens.calibration.samples.length === 0"
					@click="clearSheet"
				/>
			</div>
			<div class="note">{{ sampleText }}</div>
		</Tq.Parameter>
		<Tq.Parameter
			label="From pupil"
			icon="mdi:eye-outline"
			hint="The sheet's distances are measured from the entrance pupil. Then one target per focus setting is enough, and the pupil's place comes from Calibration › Pupil offset (Shot Sequence settings)."
		>
			<Tq.InputSwitch v-model="project.addsub.lens.originIsPupil" />
			<div v-if="project.addsub.lens.originIsPupil" class="note">
				pupil {{ (-project.addsub.calibration.pupilOffset[2]).toFixed(0) }} mm in front of the rotation centre (Calibration › Pupil offset)
			</div>
		</Tq.Parameter>
		<Tq.Parameter
			v-if="!project.addsub.lens.originIsPupil"
			label="Origin offset"
			icon="mdi:ruler"
			hint="Where the sheet's distances are measured from: mm in front of the head's rotation centre (0 = the centre itself)."
		>
			<Tq.InputNumber v-model="project.addsub.lens.originOffset" :step="1" suffix=" mm" />
		</Tq.Parameter>
		<Tq.Parameter
			v-if="!project.addsub.lens.originIsPupil"
			label="Far step"
			icon="mdi:arrow-expand-vertical"
			hint="For 4-column rows: how much farther the second (unfocused) reading was taken, mm."
		>
			<Tq.InputNumber v-model="project.addsub.lens.farStep" :step="10" suffix=" mm" />
		</Tq.Parameter>
		<Tq.Parameter
			label="Sensor width"
			icon="mdi:crop-landscape"
			hint="mm. Sigma fp: 35.9."
		>
			<Tq.InputNumber v-model="project.addsub.lens.sensorWidth" :step="0.1" suffix=" mm" />
		</Tq.Parameter>
		<Tq.Parameter
			v-if="tableLines.length"
			label="Fitted"
			icon="mdi:function-variant"
			hint="focus · in-focus distance · pinhole focal · entrance pupil, all mm from the rotation centre. * = pupil assumed / borrowed (not measured at that setting). Written to calibration.json for Houdini."
		>
			<pre class="table tq-font-numeric">{{ tableLines.join('\n') }}</pre>
		</Tq.Parameter>
	</Tq.ParameterGroup>
</template>

<style lang="stylus" scoped>
.row
	display flex
	gap var(--tq-gap-control)
	align-items center

	> :first-child
		flex 1 1 0
		min-width 0

.note
	margin-top 2px
	font-size 0.85em
	color var(--tq-color-text-mute)

.error
	display flex
	align-items center
	gap var(--tq-gap-control)

.error-text
	flex 1
	color var(--tq-color-text-mute)
	font-size 0.85em
	white-space pre-wrap

.table
	margin 0
	font-size 0.8em
	line-height 1.5
	white-space pre
	overflow-x auto
	user-select text
	color var(--tq-color-text-mute)
</style>
