<script setup lang="ts">
import {asyncComputed} from '@vueuse/core'
import {capital} from 'case'
import dateformat from 'dateformat'
import {ConfigNameList} from 'tethr'
import * as Tq from 'tweeq'
import {computed, ref, useTemplateRef} from 'vue'

import {formatAxes, planFor} from '@/addsub/plan'
import {Shot, useProjectStore} from '@/stores/project'
import {useTimelineStore} from '@/stores/timeline'
import {useViewportStore} from '@/stores/viewport'
import {resolveAssetUrl, toTime} from '@/utils'

interface Props {
	frame: number
	layer: number
}

const props = defineProps<Props>()

const project = useProjectStore()
const viewport = useViewportStore()
const timeline = useTimelineStore()

const shot = computed(() => project.shot(props.frame, props.layer))

// addsub: a frame with a shooting plan but no shot yet (plan.ts). Shown as a
// marked empty cell; nothing moves when it is selected.
const plan = computed(() => planFor(project, props.frame, props.layer))
const planTooltip = computed(() => {
	const p = plan.value
	if (!p) return undefined
	return {
		title: 'Planned',
		description: p.rig
			? formatAxes(p.rig)
			: p.camera
				? `camera ${p.camera.position.map(v => v.toFixed(0)).join(', ')}`
				: 'camera configs',
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

const shotContextActionIds = ['recall_shot_led', 'move_rig_to_shot']

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

function printShotInfo(shot: Shot) {
	const infos: [string, string][] = [
		[
			'Capture Date',
			shot.captureDate
				? dateformat(shot.captureDate, 'mmm d, yyyy HH:MM:ss')
				: '-',
		],
		['Time to Shoot', shot.shootTime ? toTime(shot.shootTime) : '-'],
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
			if (name === '') {
				return (
					'<hr style="grid-column:1/-1;width:100%;margin:.3em 0;' +
					'border:none;border-top:1px solid var(--tq-color-border)" />'
				)
			}
			const label = `<span style="color:var(--tq-color-text-mute)">${capital(name)}</span>`
			const val = `<span>${value}</span>`
			return label + val
		})
		.join('')

	return (
		'<div style="display:grid;grid-template-columns:auto auto;' +
		'gap:.2em .8em;text-align:left;font-variant-numeric:tabular-nums">' +
		cells +
		'</div>'
	)
}
</script>

<template>
	<div
		ref="$root"
		class="Shot"
		:class="{selected}"
		@click="selectShot"
		@dblclick="project.captureShot = {frame, layer}"
		@contextmenu="onContextMenu"
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
			v-tooltip="{
				content: printShotInfo(shot),
				html: true,
			}"
			class="captured"
		>
			<img v-if="lvUrl" :src="lvUrl" />
		</div>
		<div v-else-if="plan" v-tooltip="planTooltip" class="empty planned">
			<Tq.Icon icon="mdi:map-marker-path" />
		</div>
		<div v-else class="empty" />
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
