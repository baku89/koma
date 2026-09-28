<script lang="ts" setup>
/**
 * Title-bar indicator + popover for the exhibition relay (stores/relay.ts):
 * connection state at a glance, the server address, and what has been
 * pushed / who is watching. Same interaction pattern as the machine popup.
 */
import prettyBytes from 'pretty-bytes'
import * as Tq from 'tweeq'
import {computed, ref, watch} from 'vue'

import {useRelayStore} from '@/stores/relay'

const relay = useRelayStore()

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
</script>

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
			<Tq.InputString
				v-model="relay.url"
				font="monospace"
				placeholder="http://koma-exhibit.local:7777"
			/>
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

.name
	font-weight bold

.state
	font-size 0.85em
	opacity 0.7

	&.error
		color var(--tq-color-error, #e5484d)
		opacity 1

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
