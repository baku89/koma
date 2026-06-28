<script lang="ts" setup>
import * as Bndr from 'bndr-js'
import * as Tq from 'tweeq'
import {computed, nextTick, onUnmounted, ref, watch} from 'vue'

import {useAuxDevicesStore} from '@/stores/auxDevices'
import {useCncStore} from '@/stores/cnc'
import {useDmxStore} from '@/stores/dmx'
import {useProjectStore} from '@/stores/project'
import {useTimerStore} from '@/stores/timer'
import {useViewportStore} from '@/stores/viewport'
import {toTime} from '@/utils'

import TitleBarCameraConnection from './TitleBarCameraConnection.vue'

const {actions} = Tq.useTweeq()

const viewport = useViewportStore()
const project = useProjectStore()
const timer = useTimerStore()
const aux = useAuxDevicesStore()
const cnc = useCncStore()
const dmx = useDmxStore()

const gamepads = ref<string[]>([])

const gcode = ref('')

const logEl = ref<HTMLPreElement | null>(null)

// Scroll the log to the bottom whenever a new response arrives.
watch(
	() => cnc.log,
	async () => {
		await nextTick()
		if (logEl.value) {
			logEl.value.scrollTop = logEl.value.scrollHeight
		}
	}
)

async function sendGcode() {
	const line = gcode.value.trim()
	if (!line) return
	await cnc.send(line)
	gcode.value = ''
}

// CNC control dropdown. Mirrors the camera connection popup: a native Tq.Popover
// with the same click-toggle + light-dismiss guard + drag-region focus trick
// (the title bar swallows background clicks unless something in it is focused).
const cncOpen = ref(false)
const cncTrigger = ref<HTMLElement>()
let lastCncDismissAt = 0

function onCncTriggerClick() {
	if (performance.now() - lastCncDismissAt < 200) return
	cncOpen.value = !cncOpen.value
}

function onCncUpdateOpen(value: boolean) {
	if (!value) lastCncDismissAt = performance.now()
	cncOpen.value = value
}

watch(cncOpen, isOpen => {
	if (isOpen) cncTrigger.value?.focus()
})

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
	<Tq.TitleBar name="Koma" icon="favicon.svg">
		<template #left>
			<Tq.IconIndicator
				v-tooltip="{content: saveStatus.content, html: true}"
				:icon="saveStatus.icon"
			/>
			<div class="project-name"><span>{{ project.name }}</span></div>
			<Tq.InputButton
				v-tooltip="'Project Settings'"
				icon="mdi:gear"
				subtle
				@click="actions.perform('project_settings')"
			/>
		</template>
		<template #center>
			<Tq.InputGroup>
				<Tq.InputCheckbox
					v-model="viewport.isPlaying"
					:icon="viewport.isPlaying ? 'mdi:pause' : 'mdi:play'"
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
				v-tooltip="'Blackout — temporarily turn off all DMX lights'"
				icon="mdi:lightbulb-off-outline"
			/>
			<Tq.InputGroup>
				<Tq.InputButton
					v-tooltip="'Reset Timer'"
					icon="material-symbols:timer"
					@click="timer.reset"
				/>
				<Tq.InputString
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
			<Tq.IconIndicator
				v-tooltip="
					aux.tracker.enabled ? 'Tracker Connected' : 'No Tracker Available'
				"
				icon="tabler:gizmo"
				:active="aux.tracker.enabled"
			/>
			<button ref="cncTrigger" class="cnc-trigger" @click="onCncTriggerClick">
				<Tq.IconIndicator
					icon="game-icons:mechanical-arm"
					:active="cnc.connected"
				/>
			</button>
			<Tq.Popover
				:reference="cncTrigger ?? null"
				:open="cncOpen"
				placement="bottom-end"
				arrow
				@update:open="onCncUpdateOpen"
			>
				<div class="cnc-menu">
					<Tq.InputGroup>
						<Tq.InputButton
							label="Status"
							icon="mdi:information-outline"
							:disabled="!cnc.connected"
							@click="cnc.send('$$')"
						/>
						<Tq.InputButton
							:label="cnc.connected ? 'Disconnect' : 'Connect'"
							:icon="cnc.connected ? 'mdi:link-off' : 'mdi:link'"
							@click="cnc.connected ? cnc.disconnect() : cnc.connect()"
						/>
					</Tq.InputGroup>
					<Tq.InputGroup>
						<Tq.InputString
							v-model="gcode"
							font="numeric"
							:disabled="!cnc.connected"
							@confirm="sendGcode"
						/>
						<Tq.InputButton
							label="Send"
							:disabled="!cnc.connected"
							@click="sendGcode"
						/>
					</Tq.InputGroup>
					<pre ref="logEl">{{ cnc.log }}</pre>
				</div>
			</Tq.Popover>
		</template>
	</Tq.TitleBar>
</template>

<style lang="stylus" scoped>
@import '../../dev_modules/tweeq/src/common.styl'


.project-name
	display flex
	align-items center
	align-self stretch

	span
		max-width 16em
		overflow hidden
		text-overflow ellipsis
		white-space nowrap
		font-weight bold

.cnc-trigger
	display flex
	align-items center
	cursor pointer

// Chrome (surface/border/blur/shadow/padding) comes from the Popover's Balloon;
// the menu only sizes and lays out its rows.
.cnc-menu
	width 15rem
	display flex
	flex-direction column
	gap 0.5em

	pre
		white-space pre-wrap
		overflow-wrap anywhere
		margin 0
		max-height 20lh
		overflow-y auto
</style>
