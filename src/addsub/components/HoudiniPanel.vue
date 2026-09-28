<script setup lang="ts">
/**
 * Live control from Houdini over the relay (stores/houdini.ts, §13.2): the
 * switches that let `led:frame` light the wall, `rig:pose` move the Box Rig
 * and `timeline:frame` move the preview, plus what last came in.
 */
import * as Tq from 'tweeq'
import {computed} from 'vue'

import {useRelayStore} from '@/stores/relay'

import {useHoudiniStore} from '../stores/houdini'
import {useLedStore} from '../stores/led'
import {useRigStore} from '../stores/machines'

const relay = useRelayStore()
const houdini = useHoudiniStore()
const led = useLedStore()
const rig = useRigStore()

const statusText = computed(() => {
	if (!relay.enabled) return 'No relay'
	if (!relay.connected) return 'Relay offline'
	const t = houdini.lastControlAt
	if (!t) return 'Waiting'
	const age = (Date.now() - t) / 1000
	return age < 5 ? 'Receiving' : `Last ${Math.round(age)} s ago`
})

const ledText = computed(() => {
	const i = led.liveInfo
	if (!i) return '—'
	return `${i.fps.toFixed(1)} fps · ${led.liveFrame?.length ? led.liveFrame.length / 3 : 0} px` + (i.dropped ? ` · ${i.dropped} dropped` : '')
})

const poseText = computed(() => {
	const p = houdini.lastPose
	if (!p) return '—'
	const t = p.target
	const axes = `X ${t.x.toFixed(1)} Y ${t.y.toFixed(1)} Z ${t.z.toFixed(1)} · A ${t.a.toFixed(2)} B ${t.b.toFixed(2)} C ${t.c.toFixed(2)}`
	return p.reason ? `${axes} — ${p.reason}` : axes
})
</script>

<template>
	<Tq.ParameterGroup name="addsub.houdini" label="Houdini Live" icon="mdi:video-3d">
		<template #headingRight>
			<span class="state" :class="{on: relay.connected && houdini.lastControlAt}">{{ statusText }}</span>
		</template>

		<Tq.Parameter v-if="houdini.error" label="Error" icon="mdi:alert-circle-outline">
			<div class="error">
				<span class="error-text">{{ houdini.error }}</span>
				<Tq.InputButton icon="mdi:close" subtle narrow @click="houdini.error = null" />
			</div>
		</Tq.Parameter>

		<Tq.Parameter label="LED" icon="mdi:led-strip-variant" hint="Show the per-pixel colours Houdini sends (led:frame) instead of the frame's lighting">
			<div class="buttons">
				<Tq.InputSwitch v-model="led.liveLight" />
				<span class="mute">{{ ledText }}</span>
			</div>
		</Tq.Parameter>
		<Tq.Parameter label="Rig" icon="game-icons:mechanical-arm" hint="Move the Box Rig to the camera pose Houdini sends (rig:pose). Off on every launch; refused outside the rig limits or while the sequence runs">
			<div class="buttons">
				<Tq.InputSwitch v-model="houdini.rigFollow" :disabled="!rig.connected" />
				<Tq.InputNumber v-model="houdini.rigFollowFeed" class="feed" :min="1" :max="20000" :precision="0" suffix=" mm/min" />
			</div>
		</Tq.Parameter>
		<Tq.Parameter label="Pose" icon="mdi:axis-arrow">
			<span class="mute">{{ poseText }}</span>
		</Tq.Parameter>
		<Tq.Parameter label="Timeline" icon="mdi:film" hint="Move the preview to the frame Houdini's playbar is on (timeline:frame)">
			<div class="buttons">
				<Tq.InputSwitch v-model="houdini.followTimeline" />
				<span v-if="houdini.lastFrame" class="mute">previz {{ houdini.lastFrame.frame }}</span>
			</div>
		</Tq.Parameter>
	</Tq.ParameterGroup>
</template>

<style lang="stylus" scoped>
.state
	font-size 0.85em
	opacity 0.6

	&.on
		opacity 1
		color var(--tq-color-accent)

.buttons
	display flex
	align-items center
	gap var(--tq-gap-related, 0.5em)
	flex-wrap wrap

.feed
	width 8em

.mute
	font-size 0.85em
	opacity 0.7

.error
	display flex
	align-items center
	gap 0.5em

.error-text
	font-size 0.85em
	color var(--tq-color-error, #e5484d)
</style>
