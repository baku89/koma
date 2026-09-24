<script lang="ts" setup>
import * as Bndr from 'bndr-js'
import * as Tq from 'tweeq'
import {computed, onUnmounted, ref} from 'vue'

import {useMillStore, useRigStore} from '@/addsub/stores/machines'
import {useSequenceStore} from '@/addsub/stores/sequence'
import {useDmxStore} from '@/stores/dmx'
import {useProjectStore} from '@/stores/project'
import {useTimerStore} from '@/stores/timer'
import {useViewportStore} from '@/stores/viewport'
import {toTime} from '@/utils'

import TitleBarCameraConnection from './TitleBarCameraConnection.vue'
import TitleBarMachineConnection from './TitleBarMachineConnection.vue'

const {actions} = Tq.useTweeq()

const viewport = useViewportStore()
const project = useProjectStore()
const timer = useTimerStore()
const mill = useMillStore()
const rig = useRigStore()
const sequence = useSequenceStore()
const dmx = useDmxStore()

const gamepads = ref<string[]>([])

const destroyBndr = Bndr.createScope(() => {
	Bndr.gamepad()
		.devices()
		.on(gs => {
			gamepads.value = gs.map(g => g.id)
		})
})

onUnmounted(destroyBndr)

// Single status indicator: spinner while there is anything not yet safely on
// disk (opening / saving=re-sequencing / unsaved edits), otherwise the
// destination icon (local disk vs in-app OPFS).
const saveStatus = computed(() => {
	if (project.isOpening) {
		return {icon: 'eos-icons:bubble-loading', content: 'Opening…'}
	}
	if (project.isSaving) {
		return {icon: 'eos-icons:bubble-loading', content: 'Saving…'}
	}
	if (project.dirty) {
		return {icon: 'eos-icons:bubble-loading', content: 'Unsaved changes'}
	}
	return project.isSavedToDisk
		? {icon: 'clarity:hard-disk-solid', content: 'Saved to Disk'}
		: {icon: 'octicon:cache-16', content: 'Saved to App'}
})
</script>

<template>
	<Tq.TitleBar name="Koma / Milling" icon="favicon.svg">
		<template #left>
			<div class="project-name"><span>{{ project.name }}</span></div>
			<Tq.IconIndicator
				v-tooltip="{content: saveStatus.content, html: true}"
				:icon="saveStatus.icon"
				inline
			/>
			<Tq.InputButton
				v-tooltip="'Project Settings'"
				icon="mdi:gear"
				subtle
				@click="actions.perform('project_settings')"
			/>
		</template>
		<template #center>
			<Tq.InputGroup>
				<Tq.InputButton
					:icon="viewport.isPlaying ? 'mdi:pause' : 'mdi:play'"
					:subtle="!viewport.isPlaying"
					@click="viewport.isPlaying = !viewport.isPlaying"
				/>
				<Tq.InputTime
					:modelValue="viewport.previewFrame"
					:min="0"
					:max="project.allKomas.length - 1"
					:frameRate="24"
					style="width: 10em"
					@update:modelValue="viewport.setCurrentFrame"
				/>
			</Tq.InputGroup>
			<Tq.InputCheckbox
				v-model="project.isLooping"
				v-tooltip="'Loop'"
				icon="material-symbols:laps"
			/>
			<Tq.InputCheckbox
				v-model="viewport.enableHiRes"
				v-tooltip="'Hi-Res'"
				icon="mdi:high-definition"
			/>
			<Tq.InputGroup>
				<Tq.InputCheckbox
					v-model="viewport.enableOnionskin"
					v-tooltip="'Enable Onionskin'"
					icon="fluent-emoji-high-contrast:onion"
				/>
				<Tq.InputCheckbox
					v-model="viewport.coloredOnionskin"
					icon="icon-park-outline:color-filter"
					v-tooltip="'Colored Onionskin'"
					:disabled="!viewport.enableOnionskin"
				/>
			</Tq.InputGroup>
			<Tq.InputCheckbox
				v-model="dmx.blackout"
				v-tooltip="{
					title: 'Blackout',
					description: 'Temporarily turn off all DMX lights',
				}"
				icon="mdi:lightbulb-off-outline"
			/>
			<Tq.InputGroup>
				<Tq.InputButton
					v-tooltip="'Reset Timer'"
					icon="material-symbols:timer"
					subtle
					@click="timer.reset"
				/>
				<Tq.InputString
					v-tooltip="{
						title: 'Time to Shoot',
						description: 'Elapsed time since the last capture',
					}"
					:modelValue="toTime(timer.current)"
					style="width: 5em"
					font="numeric"
					align="center"
					disabled
				/>
			</Tq.InputGroup>
		</template>
		<template #right>
			<TitleBarCameraConnection />
			<Tq.IconIndicator
				v-tooltip="{
					content:
						gamepads.length > 0
							? gamepads.join('<br />')
							: 'No Gamepad Connected',
					html: true,
				}"
				:active="gamepads.length > 0"
				icon="solar:gamepad-bold"
			/>
			<button
				v-tooltip="'Emergency stop: feed-hold the mill and the Box Rig, stop the spindle (shift+esc)'"
				class="estop"
				@click="sequence.estop()"
			>
				<Tq.Icon icon="mdi:octagon" />
				ESTOP
			</button>
			<TitleBarMachineConnection :machine="mill" icon="mdi:saw-blade" />
			<TitleBarMachineConnection :machine="rig" icon="game-icons:mechanical-arm" />
		</template>
	</Tq.TitleBar>
</template>

<style lang="stylus" scoped>
@import '../../dev_modules/tweeq/src/common.styl'

.estop
	display inline-flex
	align-items center
	gap 0.3em
	height var(--tq-input-height)
	padding 0 0.7em
	margin 0 var(--tq-gap-group)
	font-weight 700
	font-size 0.8em
	letter-spacing 0.08em
	color #fff
	background #c62828
	border 1.5px solid #ff5252
	border-radius var(--tq-radius-input)
	cursor pointer
	-webkit-app-region no-drag

	&:hover
		background #e53935

	&:active
		background #8e0000


.project-name
	display flex
	align-items center
	align-self stretch
	// A bit more breathing room after the app name.
	margin-left var(--tq-gap-section)

	span
		max-width 16em
		overflow hidden
		text-overflow ellipsis
		white-space nowrap
		font-weight bold

</style>
