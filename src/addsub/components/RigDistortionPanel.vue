<script setup lang="ts">
/**
 * Four-point distortion calibration of the Box Rig (ADDSUB.md 実装メモ
 * 「リグの歪み補正」): the base point and radius, the four poses with Go /
 * Record / clear, and what the fitted correction amounts to where the rig is.
 */
import {useTweeq} from 'tweeq'
import {computed} from 'vue'

import {useProjectStore} from '@/stores/project'

import {DISTORTION_DIRECTIONS, type RigAxes} from '../rigDistortion'
import {useRigStore} from '../stores/machines'
import {useRigDistortionStore} from '../stores/rigDistortion'
import {useRigWorkStore} from '../stores/rigWork'

const Tq = useTweeq()
const project = useProjectStore()
const rig = useRigStore()
const rigWork = useRigWorkStore()
const distortion = useRigDistortionStore()

const data = computed(() => project.addsub.rigDistortion)

const recorded = computed(() => distortion.points.filter(p => p.sample).length)

const fmtAxes = (a: RigAxes, digits = 2) =>
	`${a.x.toFixed(digits)} ${a.y.toFixed(digits)} ${a.z.toFixed(digits)} · ${a.a.toFixed(digits)} ${a.b.toFixed(digits)} ${a.c.toFixed(digits)}`

const nominalTooltip = (n: RigAxes) => ({
	title: 'Nominal pose (calibrated = work axes)',
	description: `X Y Z mm · A B C °: ${fmtAxes(n, 3)}`,
})

const deltaText = (d: RigAxes) =>
	`Δ ${d.x} ${d.y} ${d.z} mm · ${d.a} ${d.b} ${d.c}°`

/** The correction in force where the rig is now, for reading. */
const hereText = computed(() => {
	const c = rigWork.correctionNow
	if (!c) return null
	const t = c.translation.map(v => v.toFixed(2)).join(' ')
	const r = c.rotation.map(v => v.toFixed(3)).join(' ')
	return `Δ here: ${t} mm · rot ${r}°`
})

const fieldText = computed(() => {
	const f = rigWork.field
	if (!data.value.enabled) return `off (${recorded.value} point${recorded.value === 1 ? '' : 's'} kept)`
	if (!f) return 'no points recorded — Calibrated = Work'
	const fit = f.count > f.unknowns ? ` · misfit ${f.residual.linear.toFixed(2)} mm / ${f.residual.rotary.toFixed(3)}°` : ''
	const kind =
		f.count >= f.unknowns
			? ['affine', f.terms.pan ? 'pan' : null, f.terms.roll ? 'roll' : null].filter(Boolean).join(' + ')
			: f.count === 1
				? 'constant offset'
				: 'partial (minimum-norm) fit'
	return `${f.count} point${f.count === 1 ? '' : 's'} · ${kind}${fit}`
})

const radiiText = computed(() => data.value.radii.join(', '))
const topPansText = computed(() => data.value.topPans.join(', '))
const rollsText = computed(() => data.value.rolls.join(', '))

const panHint = computed(() =>
	data.value.radii.length >= 2 || data.value.topPans.some(p => p !== 0)
		? 'The fit can tell a pan-dependent error (an off-centre or tilted pan axis) from a position-dependent one.'
		: 'With one radius and the top point at pan 0 only, the fit is affine in the position: a pan-axis error gets mistaken for a position gradient and shows up as soon as the camera comes closer than the calibration radius. Add a second radius (e.g. 400, 250), or calibrate the top point at pans 0, 90, −90.'
)

async function go(id: string) {
	try {
		await distortion.goTo(id)
	} catch (e) {
		alert(e instanceof Error ? e.message : String(e))
	}
}

function record(id: string) {
	try {
		distortion.record(id)
	} catch (e) {
		alert(e instanceof Error ? e.message : String(e))
	}
}

function clearAll() {
	if (confirm('Forget all recorded distortion points?')) distortion.clear()
}
</script>

<template>
	<Tq.ParameterGroup
		name="addsub.rigDistortion"
		label="Distortion"
		icon="mdi:vector-curve"
	>
		<template #headingRight>
			<span class="mute">{{ fieldText }}</span>
		</template>

		<Tq.Parameter
			label="Correct"
			icon="mdi:auto-fix"
			:hint="{
				title: 'Apply the correction',
				description:
					'On: plans, Go to Plan, previz, Houdini and the Calibrated frame of the Box Rig panel go through the fitted correction. Off: Calibrated = Work; the recorded points are kept.',
			}"
		>
			<div class="row">
				<Tq.InputSwitch v-model="data.enabled" />
				<span v-if="hereText" class="mute tq-font-numeric">{{ hereText }}</span>
			</div>
		</Tq.Parameter>

		<Tq.Parameter
			label="Base point"
			icon="mdi:target"
			hint="The marker, work coordinates (mm). The four poses look at it from `radius` away along +Z, +Y, +X and −X."
		>
			<Tq.InputVec v-model="data.base" />
		</Tq.Parameter>
		<Tq.Parameter
			label="Radii"
			icon="mdi:radius-outline"
			:hint="{
				title: 'Pupil-to-base distances (mm)',
				description: `Comma-separated; every direction below is calibrated at each. ${panHint}`,
			}"
		>
			<Tq.InputString :modelValue="radiiText" font="numeric" @confirm="distortion.setRadii($event ?? '')" />
		</Tq.Parameter>
		<Tq.Parameter
			label="Top pans"
			icon="mdi:rotate-360"
			:hint="{
				title: 'Pans (B, °) for the straight-down point',
				description: 'Looking straight down, the pan only turns the picture, so the same spot is calibrated at each of these — the cleanest way to see a pan-axis error. E.g. 0, 90, −90.',
			}"
		>
			<Tq.InputString :modelValue="topPansText" font="numeric" @confirm="distortion.setTopPans($event ?? '')" />
		</Tq.Parameter>
		<Tq.Parameter
			label="Rolls"
			icon="mdi:rotate-right"
			:hint="{
				title: 'Rolls (C, °) for the other points',
				description: 'Every other direction is calibrated at each of these rolls. A roll axis that misses the pupil swings the picture with the roll; the fit takes that out (with the pan it turns with) once rolled points exist. E.g. 0, 90, −45.',
			}"
		>
			<Tq.InputString :modelValue="rollsText" font="numeric" @confirm="distortion.setRolls($event ?? '')" />
		</Tq.Parameter>
		<Tq.Parameter
			label="Directions"
			icon="mdi:axis-arrow"
			hint="Where the camera looks at the base from. F / T / R / L / B = +Z / +Y / +X / −X / −Z; FR FL BR BL = pan ±45° / ±135°; ↑ = 45° up."
		>
			<div class="directions">
				<Tq.InputButtonToggle
					v-for="d in DISTORTION_DIRECTIONS"
					:key="d.id"
					:modelValue="data.directions.includes(d.id)"
					:label="d.short"
					:tooltip="d.label"
					@update:modelValue="distortion.setDirection(d.id, $event)"
				/>
			</div>
		</Tq.Parameter>
		<Tq.Parameter
			label="Marker"
			icon="mdi:cube-outline"
			hint="Side of the marker's face seen square-on, mm — the square the Preview reticle draws (with the lens table's focal at the camera's focus)."
		>
			<div class="row">
				<Tq.InputNumber v-model="data.markerSize" :min="1" :max="500" :step="1" suffix=" mm" />
				<Tq.InputButtonToggle
					v-model="distortion.reticle"
					label="Reticle"
					icon="mdi:crosshairs"
					:tooltip="{
						title: 'Preview reticle',
						description: 'Centre cross and the expected outline of the marker face. Comes on with Go.',
					}"
				/>
			</div>
		</Tq.Parameter>

		<Tq.ParameterHeading>Points ({{ distortion.points.length }})</Tq.ParameterHeading>
		<Tq.Parameter
			v-for="p in distortion.points"
			:key="p.point.id"
			:label="`${p.point.direction.short} ${p.point.radius}${p.point.pan ? ` B${p.point.pan}` : p.point.roll ? ` C${p.point.roll}` : ''}`"
			:icon="p.sample ? (p.stale ? 'mdi:alert-circle-outline' : 'mdi:check-circle') : 'mdi:circle-outline'"
			:hint="{...nominalTooltip(p.nominal), title: `${p.point.label} — nominal pose (calibrated = work axes)`}"
		>
			<div class="point" :class="{active: distortion.activePointId === p.point.id}">
				<span class="status tq-font-numeric" :class="{stale: p.stale, none: !p.sample}">
					<template v-if="p.deltas">{{ deltaText(p.deltas) }}</template>
					<template v-else>not recorded</template>
					<span v-if="p.stale" class="stale-note">· nominal changed since</span>
				</span>
				<Tq.InputGroup>
					<Tq.InputButton
						label="Go"
						icon="mdi:crosshairs-gps"
						:disabled="!distortion.canMove"
						:tooltip="{
							title: `Move to ${p.point.label}`,
							description: 'Sends the nominal pose uncorrected (work coordinates), at the rig feed. Then jog until the marker is right.',
						}"
						@click="go(p.point.id)"
					/>
					<Tq.InputButton
						label="Record"
						icon="mdi:content-save-outline"
						:disabled="!rig.connected || rig.mpos.x === undefined"
						:tooltip="{
							title: `Record ${p.point.label}`,
							description: p.atNominal
								? 'The rig stands exactly at the nominal pose: recording now means no error here.'
								: 'Keeps where the rig is now against the nominal pose as this point\'s error.',
						}"
						@click="record(p.point.id)"
					/>
					<Tq.InputButton
						icon="mdi:close"
						narrow
						subtle
						tooltip="Forget this point"
						:disabled="!p.sample"
						@click="distortion.clear(p.point.id)"
					/>
				</Tq.InputGroup>
			</div>
		</Tq.Parameter>

		<Tq.Parameter
			v-if="distortion.orphanSamples.length"
			label="Unused"
			icon="mdi:archive-outline"
			hint="Recorded at a direction or radius no longer in the list. They still count in the fit; clear them if they shouldn't."
		>
			<div class="row">
				<span class="mute status-text">{{ distortion.orphanSamples.join(', ') }}</span>
				<Tq.InputButton
					icon="mdi:close"
					narrow
					subtle
					tooltip="Forget these points"
					@click="distortion.orphanSamples.forEach(id => distortion.clear(id))"
				/>
			</div>
		</Tq.Parameter>

		<Tq.Parameter v-if="distortion.message || recorded > 0" label="" icon="">
			<div class="row">
				<span class="mute status-text">{{ distortion.message }}</span>
				<Tq.InputButton
					v-if="recorded > 0"
					label="Clear all"
					icon="mdi:delete-outline"
					subtle
					@click="clearAll"
				/>
			</div>
		</Tq.Parameter>
	</Tq.ParameterGroup>
</template>

<style lang="stylus" scoped>
.row
	display flex
	align-items center
	gap var(--tq-gap-control)
	min-width 0

	> .TqInputNumber
		flex 0 0 7em

.mute
	color var(--tq-color-text-mute)
	font-size 0.85em

.directions
	display flex
	flex-wrap wrap
	gap 2px

.status-text
	flex 1 1 0
	min-width 0
	overflow hidden
	text-overflow ellipsis
	white-space nowrap

.point
	display flex
	align-items center
	gap var(--tq-gap-control)
	min-width 0

	&.active .status
		color var(--tq-color-accent)

.status
	flex 1 1 0
	min-width 0
	overflow hidden
	text-overflow ellipsis
	white-space nowrap
	font-size 0.85em

	&.none
		color var(--tq-color-text-mute)

	&.stale
		color orange

.stale-note
	font-size 0.9em
</style>
