<script setup lang="ts">
import {useTweeq} from 'tweeq'
import {computed} from 'vue'

import {useProjectStore} from '@/stores/project'

import {LED_FACES} from '../config'
import {type ChaseMode, useLedStore} from '../stores/led'
import {usePrevizStore} from '../stores/previz'

const Tq = useTweeq()
const project = useProjectStore()
const led = useLedStore()
const previz = usePrevizStore()

const showSettings = Tq.config.ref('addsub.led.showSettings', false)

const statusText = computed(() => {
	if (!led.connected) return led.connecting ? 'Connecting…' : 'Disconnected'
	const i = led.info
	return i ? `v${i.version} · ${i.lines.length} lines` : 'Connected'
})

async function showCurrentFrame() {
	const pf = previz.frameFor(project.captureShot.frame)
	if (!pf?.led) return
	const blob = await previz.readBlob(pf.led)
	await led.showImageBlob(blob, {file: pf.led}).catch(() => {})
}

const FACE_LABELS: Record<(typeof LED_FACES)[number], string> = {
	L: 'L (−X)',
	B: 'B (−Z)',
	R: 'R (+X)',
	F: 'F (+Z)',
}

const chaseMode = Tq.config.ref<ChaseMode>('addsub.led.chaseMode', 'pixel')
const chaseStepMs = Tq.config.ref('addsub.led.chaseStepMs', 80)

const chaseText = computed(() => {
	const c = led.chasing
	if (!c) return null
	const name = ['L1', 'L2', 'B1', 'B2', 'R1', 'R2', 'F1', 'F2'][c.line] ?? `line ${c.line}`
	return c.mode === 'line' ? name : `${name} · px ${c.index + 1} / ${c.total}`
})
</script>

<template>
	<Tq.ParameterGroup name="addsub.led" label="LED Wall" icon="mdi:led-strip-variant">
		<template #headingRight>
			<span class="state" :class="{on: led.connected}">{{ statusText }}</span>
		</template>

		<Tq.Parameter label="Port" icon="mdi:usb-port">
			<Tq.InputButton
				v-if="!led.connected"
				label="Connect…"
				icon="mdi:link"
				:disabled="led.connecting"
				@click="led.connect()"
			/>
			<Tq.InputButton v-else label="Disconnect" icon="mdi:link-off" subtle @click="led.disconnect()" />
		</Tq.Parameter>

		<Tq.Parameter v-if="led.lastError" label="Error" icon="mdi:alert-circle-outline">
			<div class="error">
				<span class="error-text">{{ led.lastError }}</span>
				<Tq.InputButton icon="mdi:close" subtle narrow @click="led.lastError = null" />
			</div>
		</Tq.Parameter>

		<Tq.Parameter label="Output" icon="mdi:lightbulb-on-outline">
			<div class="buttons">
				<Tq.InputButton label="Frame" icon="mdi:image" tooltip="Show the capture frame's lighting" :disabled="!led.connected" @click="showCurrentFrame" />
				<Tq.InputButton label="Off" icon="mdi:lightbulb-off-outline" :disabled="!led.connected" @click="led.blackout()" />
			</div>
		</Tq.Parameter>

		<Tq.Parameter label="Work light" icon="mdi:ceiling-light" hint="Temporary all-white; the frame's lighting comes back when off">
			<Tq.InputSwitch :modelValue="led.workLight" @update:modelValue="led.setWorkLight($event)" />
		</Tq.Parameter>
		<Tq.Parameter label="Live" icon="mdi:video-3d" hint="Per-pixel colours pushed from Houdini (Houdini Live panel) instead of the frame's lighting">
			<Tq.InputSwitch v-model="led.liveLight" />
		</Tq.Parameter>
		<Tq.Parameter label="Faces" icon="mdi:cube-outline" hint="One colour per face (both lines of a face together) instead of the frame's lighting">
			<Tq.InputSwitch v-model="led.faceLight" />
		</Tq.Parameter>
		<Tq.Parameter v-for="face in LED_FACES" :key="face" :label="FACE_LABELS[face]" icon="mdi:palette">
			<Tq.InputColor v-model="project.addsub.led.faceColors[face]" />
		</Tq.Parameter>
		<Tq.Parameter label="Chase" icon="mdi:ray-start-arrow" hint="Wiring check: light the wall in line order (L1 L2 B1 B2 R1 R2 F1 F2), one pixel or one line at a time">
			<div class="buttons">
				<Tq.InputRadio v-model="chaseMode" :options="['pixel', 'line']" :labels="['Pixel', 'Line']" />
				<Tq.InputNumber v-model="chaseStepMs" class="step" :min="20" :max="2000" :step="10" :precision="0" suffix="ms" />
				<Tq.InputButton
					v-if="!led.chasing"
					label="Start"
					icon="mdi:play"
					:disabled="!led.connected"
					@click="led.startChase({mode: chaseMode, stepMs: chaseStepMs})"
				/>
				<Tq.InputButton v-else label="Stop" icon="mdi:stop" @click="led.stopChase()" />
				<span v-if="chaseText" class="mute">{{ chaseText }}</span>
			</div>
		</Tq.Parameter>
		<Tq.Parameter label="Follow" icon="mdi:auto-fix" hint="Show each capture frame's lighting automatically">
			<Tq.InputSwitch v-model="led.followCapture" />
		</Tq.Parameter>
		<Tq.Parameter label="Shown" icon="mdi:image-check">
			<span class="mute">
				{{ led.shown?.file ?? '—' }}
				<template v-if="led.lastShow"> · {{ led.lastShow.latencyMs.toFixed(0) }} ms</template>
			</span>
		</Tq.Parameter>

		<Tq.Parameter label="Cap" icon="mdi:brightness-6" hint="Brightness cap applied by the firmware">
			<Tq.InputNumber v-model="project.addsub.led.brightnessCap" :min="0" :max="1" :step="0.05" :bar="true" />
		</Tq.Parameter>

		<Tq.Parameter label="Layout" icon="mdi:map-marker-path" hint="LED placement map in use">
			<span class="mute">
				{{ led.layout.source === 'set' ? 'previz/set.json' : 'built-in (no set.json)' }}
				· v{{ led.layout.version }} · {{ led.layout.pixels.length }} px
			</span>
		</Tq.Parameter>
		<template v-if="showSettings && led.layout.source === 'builtin'">
			<Tq.Parameter label="Gain" icon="mdi:contrast" hint="Multiplier when sampling the image">
				<Tq.InputNumber v-model="project.addsub.led.gain" :min="0" :max="2" :step="0.05" />
			</Tq.Parameter>
			<Tq.Parameter label="Top Y" icon="mdi:format-vertical-align-top" hint="Film Y at the top edge of the LED images (mm)">
				<Tq.InputNumber v-model="project.addsub.led.topFilmY" :precision="1" />
			</Tq.Parameter>
			<Tq.Parameter label="Wall top" icon="mdi:arrow-collapse-up" hint="World Y of the topmost strip (mm)">
				<Tq.InputNumber v-model="project.addsub.led.layout.topY" :precision="1" />
			</Tq.Parameter>
			<Tq.Parameter label="Size X" icon="mdi:arrow-expand-horizontal" hint="Wall size along X (mm)">
				<Tq.InputNumber v-model="project.addsub.led.layout.sizeX" :precision="1" />
			</Tq.Parameter>
			<Tq.Parameter label="Size Z" icon="mdi:arrow-expand-horizontal" hint="Wall size along Z (mm)">
				<Tq.InputNumber v-model="project.addsub.led.layout.sizeZ" :precision="1" />
			</Tq.Parameter>
			<Tq.Parameter label="Height" icon="mdi:arrow-expand-vertical" hint="Strip length = wall height (mm)">
				<Tq.InputNumber v-model="project.addsub.led.layout.height" :precision="1" />
			</Tq.Parameter>
			<Tq.Parameter label="Spacing" icon="mdi:format-line-spacing" hint="Strip spacing (mm)">
				<Tq.InputNumber v-model="project.addsub.led.layout.stripSpacing" :precision="1" />
			</Tq.Parameter>
			<Tq.Parameter label="Start" icon="mdi:swap-horizontal" hint="Which end each line's first strip starts from (inside view)">
				<Tq.InputRadio v-model="project.addsub.led.layout.startSide" :options="['left', 'right']" />
			</Tq.Parameter>
		</template>
		<li class="more">
			<button class="toggle" @click="showSettings = !showSettings">
				{{ showSettings ? 'Hide layout' : 'Layout…' }}
			</button>
		</li>
	</Tq.ParameterGroup>
</template>

<style lang="stylus" scoped>
.state
	font-size 0.85em
	color var(--tq-color-text-mute)

	&.on
		color var(--tq-color-text)

.error
	display flex
	align-items center
	gap var(--tq-gap-control)

.error-text
	flex 1 1 0
	min-width 0
	font-size 0.85em
	color var(--tq-color-text-mute)
	overflow hidden
	text-overflow ellipsis
	white-space nowrap

.buttons
	display flex
	flex-wrap wrap
	gap var(--tq-gap-group)

.mute
	color var(--tq-color-text-mute)
	font-size 0.85em

.step
	flex 0 0 5.5em

.more
	grid-column 1 / 3
	list-style none
	padding-left var(--tq-gap-section)

.toggle
	background var(--tq-color-input)
	height var(--tq-input-height)
	padding 0 1em
	border-radius 9999px
	font-size 0.85em

	&:hover
		background var(--tq-color-input-hover)
</style>
