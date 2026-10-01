<script lang="ts" setup>
/**
 * Title-bar indicator + popover for the exhibition relay (stores/relay.ts):
 * connection state at a glance, the server address, and what has been
 * pushed / who is watching. Same interaction pattern as the machine popup.
 */
import prettyBytes from 'pretty-bytes'
import QRCode from 'qrcode'
import * as Tq from 'tweeq'
import {computed, ref, watch} from 'vue'

import {RELAY_DEFAULT_PORT, useRelayStore} from '@/stores/relay'
import {useRemoteJogStore} from '@/stores/remoteJog'

const relay = useRelayStore()
const remoteJog = useRemoteJogStore()

const open = ref(false)
const trigger = ref<HTMLElement>()
let lastDismissAt = 0

function onTriggerClick() {
	if (performance.now() - lastDismissAt < 200) return
	open.value = !open.value
}

function onUpdateOpen(value: boolean) {
	if (!value) lastDismissAt = performance.now()
	open.value = value
}

watch(open, isOpen => {
	if (isOpen) trigger.value?.focus()
})

const stateText = computed(() => {
	if (!relay.enabled) return 'Off'
	if (relay.connected) {
		return relay.syncing ? `Syncing… ${relay.pending} left` : 'Connected'
	}
	return relay.connecting ? 'Connecting…' : (relay.error ?? 'Disconnected')
})

const tooltip = computed(() => {
	if (!relay.enabled) return 'Exhibit relay: off (set the address in the popup)'
	return `Exhibit relay: ${stateText.value}`
})

const lastSync = computed(() =>
	relay.lastSyncAt ? new Date(relay.lastSyncAt).toLocaleTimeString() : '—'
)

const stateClass = computed(() => {
	if (!relay.enabled) return ''
	if (relay.error || relay.syncError) return 'error'
	if (relay.syncing) return 'busy'
	return ''
})

// Phone jog pendant (/jog.html served by the relay; stores/remoteJog.ts).
// Built from the relay's LAN address, not from what was typed here.
const jogUrl = computed(() => {
	if (!relay.enabled) return ''
	const t = relay.token ? `?token=${encodeURIComponent(relay.token)}` : ''
	return `${relay.lanUrl}/jog.html${t}`
})
const jogUrlNote = computed(() => {
	if (!relay.enabled) return ''
	if (!relay.connected) return 'address known once connected'
	if (!relay.lanHosts.length) return 'relay did not report a LAN address — is it up to date?'
	return relay.lanHosts.length > 1 ? `also: ${relay.lanHosts.slice(1).join(', ')}` : ''
})
const jogQr = ref('')
watch(
	jogUrl,
	async url => {
		jogQr.value = url
			? await QRCode.toDataURL(url, {margin: 1, width: 160, color: {dark: '#000000', light: '#ffffff'}}).catch(
					() => ''
				)
			: ''
	},
	{immediate: true}
)</script>

<template>
	<button
		ref="trigger"
		v-tooltip="tooltip"
		class="trigger"
		:class="stateClass"
		@click="onTriggerClick"
	>
		<Tq.IconIndicator
			:icon="relay.syncing ? 'eos-icons:bubble-loading' : 'mdi:monitor-share'"
			:active="relay.enabled ? relay.connected : undefined"
			glow
		/>
	</button>
	<Tq.Popover
		:reference="trigger ?? null"
		:open="open"
		placement="bottom-end"
		arrow
		exit-transition
		@update:open="onUpdateOpen"
	>
		<div class="menu">
			<div class="head">
				<span class="name">Exhibit relay</span>
				<span class="state" :class="stateClass">{{ stateText }}</span>
			</div>
			<Tq.InputGroup>
				<Tq.InputString
					v-model="relay.host"
					v-tooltip="'Host name or IP of the exhibit machine (koma-relay)'"
					font="monospace"
					placeholder="koma-exhibit.local"
					class="host"
					@confirm="relay.normalizeHost()"
				/>
				<Tq.InputNumber
					v-model="relay.port"
					v-tooltip="`Port (koma-relay default ${RELAY_DEFAULT_PORT})`"
					:min="1"
					:max="65535"
					:step="1"
					:precision="0"
					:default="RELAY_DEFAULT_PORT"
					:bar="false"
					prefix=":"
					class="port"
				/>
			</Tq.InputGroup>
			<Tq.InputString
				v-model="relay.token"
				font="monospace"
				placeholder="token (optional)"
			/>
			<Tq.InputGroup>
				<Tq.InputButton
					label="Sync now"
					icon="mdi:cloud-upload-outline"
					:disabled="!relay.connected"
					@click="relay.syncNow()"
				/>
				<Tq.InputButton
					label="Reconnect"
					icon="mdi:refresh"
					:disabled="!relay.enabled"
					@click="relay.connect()"
				/>
			</Tq.InputGroup>
			<dl class="stats">
				<dt>Screens</dt>
				<dd>{{ relay.peers.length }} connected · {{ relay.liveViewers }} watching live view</dd>
				<dt>Display copy</dt>
				<dd>last sync {{ lastSync }} · {{ prettyBytes(relay.pushedBytes) }} sent</dd>
				<template v-if="relay.syncError">
					<dt>Error</dt>
					<dd class="error">{{ relay.syncError }}</dd>
				</template>
			</dl>
			<div v-if="relay.enabled" class="jog">
				<div class="jog-head">
					<Tq.InputCheckbox
						v-model="remoteJog.enabled"
						v-tooltip="'Allow the phone jog page to move the machines (via the relay)'"
						label="Phone jog"
					/>
					<a :href="jogUrl" target="_blank" rel="noopener" class="jog-link">{{ jogUrl }}</a>
					<span v-if="jogUrlNote" class="jog-note">{{ jogUrlNote }}</span>
				</div>
				<img v-if="jogQr" :src="jogQr" class="jog-qr" alt="QR code of the jog page" />
			</div>
		</div>
	</Tq.Popover>
</template>

<style lang="stylus" scoped>
.trigger
	display flex
	align-items center
	cursor pointer

	&.error :deep(.TqIconIndicator)
		color var(--tq-color-error, #e5484d)

.menu
	width 17rem
	display flex
	flex-direction column
	gap 0.5em

.head
	display flex
	justify-content space-between
	align-items baseline
	gap 0.5em

.host
	flex 1

.port
	width 5.5em
	flex none

.name
	font-weight bold

.state
	font-size 0.85em
	opacity 0.7

	&.error
		color var(--tq-color-error, #e5484d)
		opacity 1

.jog
	display flex
	gap 0.6em
	align-items flex-start
	padding-top 0.3em
	border-top 1px solid var(--tq-color-border, rgba(128, 128, 128, 0.3))

.jog-head
	flex 1 1 0
	min-width 0
	display flex
	flex-direction column
	gap 0.3em

.jog-link
	font-family var(--tq-font-code, monospace)
	font-size 0.75em
	color var(--tq-color-text-mute)
	overflow-wrap anywhere

.jog-note
	font-size 0.7em
	color var(--tq-color-text-mute)

.jog-qr
	width 5.5em
	height 5.5em
	border-radius var(--tq-radius-input)
	image-rendering pixelated

.stats
	display grid
	grid-template-columns auto 1fr
	gap 0.2em 0.8em
	margin 0
	font-size 0.85em

	dt
		opacity 0.6

	dd
		margin 0

	.error
		color var(--tq-color-error, #e5484d)
</style>
