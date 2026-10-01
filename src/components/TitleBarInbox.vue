<script lang="ts" setup>
/**
 * Title-bar indicator for the project inbox (stores/inbox.ts): appears once
 * a patch dropped into `_inbox/` has been handled this session, lit until
 * its popover is opened. Lists what was applied or rejected, and why.
 */
import * as Tq from 'tweeq'
import {computed, ref, watch} from 'vue'

import {useInboxStore} from '@/stores/inbox'

const inbox = useInboxStore()

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
	if (isOpen) inbox.markSeen()
})

const latest = computed(() => inbox.entries[0])
const hasError = computed(
	() => inbox.unseen > 0 && inbox.entries.slice(0, inbox.unseen).some(e => e.status === 'rejected')
)

const tooltip = computed(() => {
	const e = latest.value
	if (!e) return 'Inbox'
	return {
		title: e.status === 'applied' ? 'Inbox: patch applied' : 'Inbox: patch rejected',
		description: e.note || e.name,
	}
})

function summary(e: (typeof inbox.entries)[number]) {
	if (e.status === 'rejected') return 'rejected'
	return e.skipped > 0 ? `${e.applied} applied · ${e.skipped} skipped` : `${e.applied} applied`
}
</script>

<template>
	<button
		v-if="inbox.entries.length > 0"
		ref="trigger"
		v-tooltip="tooltip"
		class="trigger"
		:class="{error: hasError}"
		@click="onTriggerClick"
	>
		<Tq.IconIndicator
			icon="mdi:inbox-arrow-down"
			:active="inbox.unseen > 0"
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
				<span class="name">Inbox</span>
				<span class="state">patches from _inbox/</span>
			</div>
			<div
				v-for="e in inbox.entries"
				:key="`${e.name}@${e.at}`"
				class="entry"
				:class="e.status"
			>
				<div class="head">
					<span class="note">{{ e.note || e.name }}</span>
					<span class="state tq-font-numeric">{{ new Date(e.at).toLocaleTimeString() }}</span>
				</div>
				<div class="state" :class="{error: e.status === 'rejected'}">
					{{ summary(e) }}<template v-if="e.note"> · {{ e.name }}</template>
				</div>
				<div v-if="e.error" class="detail error">{{ e.error }}</div>
				<div v-for="(m, i) in e.messages.slice(0, 5)" :key="i" class="detail">{{ m }}</div>
				<div v-if="e.messages.length > 5" class="detail">… {{ e.messages.length - 5 }} more</div>
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
	width 19rem
	max-height 60vh
	overflow-y auto
	display flex
	flex-direction column
	gap 0.5em

.head
	display flex
	justify-content space-between
	align-items baseline
	gap 0.5em

.name
.note
	font-weight bold

.note
	overflow-wrap anywhere

.state
	font-size 0.85em
	opacity 0.7
	white-space nowrap

	&.error
		color var(--tq-color-error, #e5484d)
		opacity 1

.entry
	padding-top 0.4em
	border-top 1px solid var(--tq-color-border, rgba(128, 128, 128, 0.3))

.detail
	font-size 0.8em
	color var(--tq-color-text-mute)
	overflow-wrap anywhere

	&.error
		color var(--tq-color-error, #e5484d)
</style>
