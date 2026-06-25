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

const viewport = useViewportStore()
const project = useProjectStore()
const timer = useTimerStore()
const aux = useAuxDevicesStore()
const cnc = useCncStore()
const dmx = useDmxStore()

const gamepads = ref<string[]>([])

const gamepad = Bndr.gamepad()

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

const destroyBndr = Bndr.createScope(() => {
	gamepad.devices().on(gs => {
		gamepads.value = gs.map(
			g => (g as any).id ?? (g as any).device?.productName ?? 'Gamepad'
		)
	})
})

onUnmounted(destroyBndr)

// WebHID controllers (Joy-Con) require an explicit, user-gesture permission
// prompt — unlike standard gamepads (Xbox, DualSense) which the Gamepad API
// exposes automatically. Clicking the gamepad indicator triggers that prompt;
// once granted the device auto-reconnects on later launches.
async function connectGamepad() {
	try {
		await gamepad.requestDevice()
	} catch {
		// WebHID unsupported (non-Chromium) or the user dismissed the picker.
	}
}

const destinationInfo = computed(() => {
	if (project.isSavedToDisk) {
		return {
			content: 'Saved to Disk',
			html: true,
		}
	} else {
		return {
			content: `Saved to App`,
			html: true,
		}
	}
})
</script>

<template>
	<Tq.TitleBar name="Koma" icon="favicon.svg">
		<template #left>
			<Tq.InputString v-model="project.name" style="width: 10em" />
			<Tq.IconIndicator
				v-tooltip="destinationInfo"
				:icon="
					project.isSavedToDisk ? 'clarity:hard-disk-solid' : 'octicon:cache-16'
				"
			/>
			<Tq.Icon
				v-show="project.isSaving || project.isOpening"
				icon="eos-icons:bubble-loading"
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
							: 'Click to connect a Joy-Con (WebHID)',
					html: true,
				}"
				:active="gamepads.length > 0"
				icon="solar:gamepad-bold"
				style="cursor: pointer"
				@click="connectGamepad"
			/>
			<Tq.IconIndicator
				v-tooltip="
					aux.tracker.enabled ? 'Tracker Connected' : 'No Tracker Available'
				"
				icon="tabler:gizmo"
				:active="aux.tracker.enabled"
			/>
			<vDropdown :triggers="['click']">
				<Tq.IconIndicator
					icon="game-icons:mechanical-arm"
					:active="cnc.connected"
					style="cursor: pointer"
				/>
				<template #popper>
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
				</template>
			</vDropdown>
		</template>
	</Tq.TitleBar>
</template>

<style lang="stylus" scoped>
@import '../../dev_modules/tweeq/src/common.styl'


.cnc-menu
	padding var(--tq-popup-padding)
	width 15rem
	display flex
	flex-direction column
	gap .5em

	pre
		white-space pre-wrap
		overflow-wrap anywhere
		margin 0
		max-height 20lh
		overflow-y auto
</style>
