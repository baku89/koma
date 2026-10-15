<script setup lang="ts">
import {useTweeq} from 'tweeq'
import {computed} from 'vue'

import {useProjectStore} from '@/stores/project'

import {LED_FACES} from '../config'
import {type ChaseMode, LED_MODE_ICONS, LED_MODE_LABELS, LED_MODES, useLedStore} from '../stores/led'

const Tq = useTweeq()
const project = useProjectStore()
const led = useLedStore()

const statusText = computed(() => {
	if (!led.connected) return led.connecting ? 'Connecting…' : 'Disconnected'
	const i = led.info
	return i ? `v${i.version} · ${i.lines.length} lines` : 'Connected'
})

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

		<Tq.Parameter
			label="Output"
			icon="mdi:lightbulb-on-outline"
			:hint="{
				title: 'What drives the wall',
				description: 'Off: koma sends nothing (choosing it blacks the wall out). Work light: all white; the mode it covered comes back before a capture. Live: per-pixel colours from Houdini (Houdini Live panel). Faces: one colour per face.',
			}"
		>
			<Tq.InputRadio
				:modelValue="led.mode"
				:options="[...LED_MODES]"
				:labels="LED_MODE_LABELS"
				:tooltips="LED_MODE_LABELS"
				:icons="LED_MODE_ICONS"
				@update:modelValue="led.setMode($event)"
			/>
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
		<Tq.Parameter v-if="led.lastShow" label="Latch" icon="mdi:timer-outline" hint="How long the wall took to show the last frame sent">
			<span class="mute">{{ led.lastShow.latencyMs.toFixed(0) }} ms</span>
		</Tq.Parameter>

		<Tq.Parameter label="Cap" icon="mdi:brightness-6" hint="Brightness cap applied by the firmware">
			<Tq.InputNumber v-model="project.addsub.led.brightnessCap" :min="0" :max="1" :step="0.05" :bar="true" />
		</Tq.Parameter>

		<Tq.Parameter label="Gain" icon="mdi:contrast" hint="Multiplier on the live feed's colours">
			<Tq.InputNumber v-model="project.addsub.led.gain" :min="0" :max="2" :step="0.05" />
		</Tq.Parameter>
		<Tq.Parameter label="Layout" icon="mdi:map-marker-path" hint="LED placement map (hard-coded from the Houdini set model, led/layout.ts)">
			<span class="mute">v{{ led.layout.version }} · {{ led.layout.pixels.length }} px · {{ led.layout.lineCounts.join('/') }}</span>
		</Tq.Parameter>
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
</style>
