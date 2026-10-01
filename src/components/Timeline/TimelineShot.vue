<script setup lang="ts">
import {asyncComputed} from '@vueuse/core'
import {capital} from 'case'
import dateformat from 'dateformat'
import {ConfigNameList} from 'tethr'
import * as Tq from 'tweeq'
import {computed, ref, useTemplateRef} from 'vue'

import {RIG_DEFINITION} from '@/addsub/config'
import {formatDuration, isGcodeFilename} from '@/addsub/cuts'
import {effectivePlanFor, formatPlan} from '@/addsub/plan'
import {useRigStore} from '@/addsub/stores/machines'
import {useSequenceStore} from '@/addsub/stores/sequence'
import {Shot, useProjectStore} from '@/stores/project'
import {useTimelineStore} from '@/stores/timeline'
import {useViewportStore} from '@/stores/viewport'
import {resolveAssetUrl, toTime} from '@/utils'
import type {Axis} from '@/utils/fluidnc'

interface Props {
	frame: number
	layer: number
}

const props = defineProps<Props>()

const project = useProjectStore()
const viewport = useViewportStore()
const timeline = useTimelineStore()
const sequence = useSequenceStore()
const rig = useRigStore()

const shot = computed(() => project.shot(props.frame, props.layer))

// addsub: the G-code this frame runs before it is shot (cuts.ts) — a file
// dropped on the cell, else previz's cut — and whether it has run.
const gcode = computed(() => sequence.gcodeFor(props.frame, props.layer))
const cutDone = computed(() => {
	const g = gcode.value
	return !!g && !!g.cut?.run?.done && g.cut.file === g.path
})
const cutTooltip = computed(() => {
	const g = gcode.value
	if (!g) return undefined
	const run = g.cut?.run
	const desc = run
		? run.done
			? `Cut in ${formatDuration(run.durationMs)}`
			: `Stopped at line ${run.linesSent}/${run.total}${run.error ? `: ${run.error}` : ''}`
		: 'Not cut yet'
	return {title: `${g.source === 'file' ? 'G-code' : 'previz G-code'}: ${g.name}`, description: desc}
})

// Drop .nc / .gcode files on the cell to attach them: one file → this frame,
// several → this frame onwards in name order.
const dropping = ref(false)

function hasFiles(e: DragEvent) {
	return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
}

function onDragOver(e: DragEvent) {
	if (!hasFiles(e)) return
	e.preventDefault()
	e.dataTransfer!.dropEffect = 'copy'
	dropping.value = true
}

async function onDrop(e: DragEvent) {
	dropping.value = false
	if (!hasFiles(e)) return
	e.preventDefault()
	const files = Array.from(e.dataTransfer!.files)
		.filter(f => isGcodeFilename(f.name))
		.sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true}))
	if (files.length === 0) {
		alert('Drop G-code files (.nc, .gcode, .ngc, .tap)')
		return
	}
	try {
		for (const [i, file] of files.entries()) {
			await sequence.attachCutFile(props.frame + i, props.layer, file)
		}
	} catch (err) {
		alert(err instanceof Error ? err.message : String(err))
	}
}

// addsub: a frame with a shooting plan but no shot yet (plan.ts) — its own
// or one interpolated between planned frames. Shown as a marked empty cell
// (dimmer when interpolated); nothing moves when it is selected.
const plan = computed(() => effectivePlanFor(project, props.frame, props.layer))
const planTooltip = computed(() => {
	const p = plan.value
	if (!p) return undefined
	return {
		title: p.kind === 'interpolated' ? `Planned (interpolated ${p.from}–${p.to})` : 'Planned',
		description: formatPlan(p.plan, 0),
	}
})

const lvUrl = asyncComputed(async () => {
	// Regenerate the lv from the hi-res jpg if its file is missing, then resolve.
	await project.ensureLv(props.frame, props.layer)
	return resolveAssetUrl(shot.value?.lv)
})

const selected = computed(() => {
	return (
		props.frame === viewport.currentFrame &&
		props.layer === viewport.currentLayer &&
		viewport.isShotSelected
	)
})

function insertEmptyFrame(frame: number) {
	project.$patch(state => {
		state.komas.splice(frame, 0, {shots: []})
		if (frame <= state.captureShot.frame) {
			state.captureShot.frame += 1
		}
		if (frame <= project.previewRange[1]) {
			state.previewRange[1] += 1
		}
	})
}

function selectShot() {
	viewport.setCurrentFrame(props.frame)
	viewport.setCurrentLayer(props.layer)
	viewport.selectShot()
}

// Right-click: select the cell, then offer the registered actions that act on
// the selected shot (they read viewport.currentFrame / currentLayer). Listed by
// action id so the menu stays in sync with labels, icons and shortcuts.
const {actions} = Tq.useTweeq()

const shotContextActionIds = [
	'plan_set_from_current',
	'go_to_plan_selected',
	'plan_clear',
	'recall_shot_led',
	'move_rig_to_shot',
]

const $root = useTemplateRef('$root')
const menuOpen = ref(false)
const menuPosition = ref<[number, number]>([0, 0])

const contextMenuItems = computed<Tq.MenuItem[]>(() =>
	shotContextActionIds.flatMap(id => {
		const action = actions.allActions[id]
		if (!action) return []
		return [
			{
				label: action.label,
				icon: action.icon,
				bindIcon: action.bind?.icon,
				perform: () => actions.perform(id),
			},
		]
	})
)

function onContextMenu(e: MouseEvent) {
	if (contextMenuItems.value.length === 0) return
	e.preventDefault()
	selectShot()
	menuPosition.value = [e.clientX, e.clientY]
	menuOpen.value = true
}

const HR =
	'<hr style="grid-column:1/-1;width:100%;margin:.3em 0;' +
	'border:none;border-top:1px solid var(--tq-color-border)" />'

// addsub: the Box Rig axes the shot was taken at (machine coordinates), as a
// block of the tooltip that sends the rig back there when clicked: the header
// row moves every axis, an axis row just that one. The `data-tooltip-action`
// elements run the tooltip's actions of the same name (`rig`, `rig-x`, …).
function rigAxesOf(shot: Shot): Axis[] {
	const pos = shot.rig
	if (!pos) return []
	return RIG_DEFINITION.axes.filter(a => pos[a] !== undefined)
}

function printRigInfo(shot: Shot) {
	const pos = shot.rig
	const axes = rigAxesOf(shot)
	if (!pos || axes.length === 0) return ''

	const mute = 'color:var(--tq-color-text-mute)'
	const row = 'display:flex;justify-content:space-between'

	// recallRig lifts Y by the blocks appended since the shot (§7.2), so say so
	// when where it goes differs from what is listed.
	const dLift = project.addsub.filmLift - (shot.filmLift ?? 0)
	const hint = !rig.connected
		? 'Not connected'
		: dLift !== 0
			? `Click to move (Y ${dLift > 0 ? '+' : ''}${dLift} mm lift)`
			: 'Click to move'

	const cells = axes
		.map(axis => {
			const value =
				pos[axis]!.toFixed(3) +
				(RIG_DEFINITION.axisInfo?.[axis]?.unit === 'deg' ? '°' : ' mm')
			return (
				`<span data-tooltip-action="rig-${axis}" style="${row};gap:.8em">` +
				`<span style="${mute}">${axis.toUpperCase()}</span>` +
				`<span>${value}</span></span>`
			)
		})
		.join('')

	// Column flow, three rows: X Y Z down the left, A B C down the right.
	return (
		'<div style="grid-column:1/-1;display:grid;gap:.4em">' +
		`<div data-tooltip-action="rig" style="${row};gap:1.2em">` +
		`<span style="${mute}">${RIG_DEFINITION.label}</span>` +
		`<span style="${mute};font-size:.9em">${hint}</span></div>` +
		'<div style="display:grid;grid-auto-flow:column;' +
		'grid-template-rows:repeat(3,auto);gap:.4em 1.4em">' +
		cells +
		'</div></div>'
	)
}

async function moveRigToShot(axes?: Axis[]) {
	try {
		await sequence.recallRig(props.frame, props.layer, axes)
	} catch (e) {
		alert(e instanceof Error ? e.message : String(e))
	}
}

const shotTooltip = computed(() => {
	const s = shot.value
	if (!s) return undefined
	const rigInfo = printRigInfo(s)
	if (!rigInfo) return {content: printShotInfo(s), html: true}
	const actions: Record<string, () => void> = {rig: () => moveRigToShot()}
	for (const axis of rigAxesOf(s)) {
		actions[`rig-${axis}`] = () => moveRigToShot([axis])
	}
	return {content: printShotInfo(s, rigInfo), html: true, actions}
})

// The tooltip is rendered with v-html; file names come from outside.
const escapeHtml = (text: string) =>
	text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// addsub: how long the frame's G-code took on the mill (wall clock, from the
// first line sent to the mill going Idle). The cell's last run when there is
// one, else what was recorded on the shot when it was taken.
function printCutInfo(shot: Shot): [string, string][] {
	const g = gcode.value
	const run = g?.cut?.run
	if (g && run) {
		const time = formatDuration(run.durationMs)
		return [
			['Cut File', escapeHtml(g.name)],
			[
				'Time to Cut',
				run.done ? time : `${time} (stopped at line ${run.linesSent}/${run.total})`,
			],
		]
	}
	if (shot.cut) {
		return [
			['Cut File', escapeHtml(shot.cut.file.split('/').pop() ?? shot.cut.file)],
			['Time to Cut', formatDuration(shot.cut.durationMs)],
		]
	}
	return []
}

function printShotInfo(shot: Shot, rigInfo = '') {
	const infos: [string, string][] = [
		[
			'Capture Date',
			shot.captureDate
				? dateformat(shot.captureDate, 'mmm d, yyyy HH:MM:ss')
				: '-',
		],
		['Time to Shoot', shot.shootTime ? toTime(shot.shootTime) : '-'],
		...printCutInfo(shot),
		['Jpeg Filename', shot.jpgFilename ?? '-'],
		['', ''],
	]

	const configs = Object.entries((shot.cameraConfigs ?? {}) as any).filter(
		([name]) => ConfigNameList.includes(name as any)
	)

	// Rendered via the tooltip's v-html, so styling is inline (scoped CSS can't
	// reach it). A 2-column grid keeps labels and values aligned.
	const cells = [...infos, ...configs]
		.map(([name, value]) => {
			if (name === '') return HR
			const label = `<span style="color:var(--tq-color-text-mute)">${capital(name)}</span>`
			const val = `<span>${value}</span>`
			return label + val
		})
		.join('')

	return (
		'<div style="display:grid;grid-template-columns:auto auto;' +
		'gap:.2em .8em;text-align:left;font-variant-numeric:tabular-nums">' +
		cells +
		(rigInfo ? (configs.length > 0 ? HR : '') + rigInfo : '') +
		'</div>'
	)
}
</script>

<template>
	<div
		ref="$root"
		class="Shot"
		:class="{selected, dropping}"
		@click="selectShot"
		@dblclick="project.captureShot = {frame, layer}"
		@contextmenu="onContextMenu"
		@dragover="onDragOver"
		@dragleave="dropping = false"
		@drop="onDrop"
	>
		<div
			v-if="
				frame === project.captureShot.frame &&
				layer === project.captureShot.layer
			"
			class="liveview"
		>
			<Tq.Icon icon="material-symbols:photo-camera-outline" />
		</div>
		<div
			v-else-if="shot"
			v-tooltip="shotTooltip"
			class="captured"
		>
			<img v-if="lvUrl" :src="lvUrl" />
		</div>
		<div
			v-else-if="plan"
			v-tooltip="planTooltip"
			class="empty planned"
			:class="{interpolated: plan.kind === 'interpolated'}"
		>
			<Tq.Icon :icon="plan.kind === 'interpolated' ? 'mdi:map-marker-outline' : 'mdi:map-marker-path'" />
		</div>
		<div v-else class="empty" />
		<div
			v-if="gcode"
			v-tooltip="cutTooltip"
			class="cut"
			:class="{done: cutDone, dropped: gcode.source === 'file'}"
		>
			<Tq.Icon :icon="cutDone ? 'mdi:check-bold' : 'mdi:saw-blade'" />
		</div>
		<div
			v-if="timeline.frameWidth > 40"
			v-tooltip="'Insert'"
			class="in-between transition"
			@click="insertEmptyFrame(frame)"
		/>
		<!-- Teleported out of the cell: its overflow hidden would clip the menu. -->
		<Tq.Popover
			v-if="menuOpen"
			:reference="$root"
			:placement="menuPosition"
			:open="menuOpen"
			teleport=".TqViewport"
			@update:open="menuOpen = $event"
		>
			<Tq.Menu :items="contextMenuItems" @close="menuOpen = false" />
		</Tq.Popover>
	</div>
</template>

<style scoped lang="stylus">
.Shot
	position relative
	flex 0 0 var(--frame-width)
	margin-left 1px
	width calc(var(--frame-width) - 1px)
	height var(--layer-height)
	overflow hidden

	&.dropping:after
		content ''
		display block
		position absolute
		inset 0
		border 2px dashed var(--tq-color-accent)
		border-radius var(--tq-radius-input)
		background unquote('color-mix(in srgb, var(--tq-color-accent) 20%, transparent)')
		z-index 11
		pointer-events none

	&.selected:before
		content ''
		display block
		position absolute
		inset 0
		border 2px solid var(--tq-color-selection)
		border-radius var(--tq-radius-input)
		z-index 10
		pointer-events none

.captured
.liveview
.empty
	position relative
	width 100%
	height 100%
	text-align center
	display flex
	flex-direction column
	justify-content center
	align-items center
	border-radius var(--tq-radius-input)

.captured
	overflow hidden
	box-shadow inset 0 0 0 1px var(--tq-color-border)

	img
		height 100%
		object-fit contain

.liveview
	background var(--tq-color-rec)

.empty
	background transparent
	opacity 0.8

	&:hover
		background var(--tq-color-input-hover)

	&.planned
		color var(--tq-color-text-mute)
		border 1px dashed var(--tq-color-text-mute)

		&.interpolated
			opacity 0.5
			border-style dotted

// G-code badge (addsub): orange until the frame has been cut, then muted.
.cut
	position absolute
	left 3px
	bottom 3px
	z-index 5
	display flex
	align-items center
	justify-content center
	width 14px
	height 14px
	border-radius 50%
	font-size 10px
	color #fff
	background #e0801a
	pointer-events auto

	&.done
		background var(--tq-color-text-mute)
		opacity 0.7

.in-between
	position absolute
	top 0
	height 100%
	width 8px
	left -4px
	z-index 10

	&:before
		position absolute
		content ''
		display block
		inset 0
		transform scaleX(0)

	&:hover:before
		transform scaleX(1)
		background var(--tq-color-accent)
</style>
