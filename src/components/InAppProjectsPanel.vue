<script setup lang="ts">
import {useTweeq} from 'tweeq'
import {onMounted, ref} from 'vue'

import {useOpfsStore} from '@/stores/opfs'
import {useProjectStore} from '@/stores/project'

const Tq = useTweeq()
const project = useProjectStore()
const opfs = useOpfsStore()

type Row = Awaited<ReturnType<typeof project.listInAppProjects>>[number]

const rows = ref<Row[]>([])
const busy = ref(false)

async function refresh() {
	rows.value = await project.listInAppProjects()
}

onMounted(refresh)

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`
	if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
	return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

// Serialize the (file-system) actions so the list never refreshes mid-mutation.
async function run(fn: () => Promise<void>) {
	if (busy.value) return
	busy.value = true
	try {
		await fn()
		await refresh()
	} finally {
		busy.value = false
	}
}

function onOpen(row: Row) {
	run(() => project.open(row.handle))
}

function onDelete(row: Row) {
	if (!confirm(`Delete “${row.name}”? This can't be undone.`)) return
	run(() => project.deleteInAppProject(row))
}

async function onRename(row: Row) {
	const result = await Tq.modal.prompt(
		{name: row.name},
		{name: {type: 'string'}},
		{title: 'Rename Project'}
	)
	if (!result || !result.name.trim()) return
	run(() => project.renameInAppProject(row, result.name))
}

function onExport(row: Row) {
	// The folder picker throwing (user cancelled) shouldn't surface as an error.
	run(() => project.exportInAppProjectToFolder(row).catch(() => undefined))
}
</script>

<template>
	<div class="InAppProjectsPanel">
		<div class="storage">
			Storage used: {{ formatSize(opfs.usage) }} / {{ formatSize(opfs.quota) }}
		</div>

		<ul class="list">
			<li
				v-for="row in rows"
				:key="row.dirName"
				class="row"
				:class="{current: row.current}"
			>
				<Tq.Icon class="icon" icon="octicon:cache-16" />
				<div class="name">
					{{ row.name }}
					<span v-if="row.current" class="badge">open</span>
				</div>
				<div class="size">{{ formatSize(row.size) }}</div>
				<Tq.InputGroup class="actions">
					<Tq.InputButton
						v-tooltip="'Open'"
						subtle
						icon="mdi:folder-open-outline"
						:disabled="row.current || busy"
						@click="onOpen(row)"
					/>
					<Tq.InputButton
						subtle
						icon="mdi:rename-outline"
						label="Rename"
						:disabled="busy"
						@click="onRename(row)"
					/>
					<Tq.InputButton
						subtle
						icon="mdi:folder-move-outline"
						label="Move to Folder…"
						:disabled="busy"
						@click="onExport(row)"
					/>
					<Tq.InputButton
						v-tooltip="'Delete'"
						subtle
						icon="mdi:trash-can-outline"
						:disabled="busy"
						@click="onDelete(row)"
					/>
				</Tq.InputGroup>
			</li>
			<li v-if="rows.length === 0" class="empty">No in-app projects yet.</li>
		</ul>
	</div>
</template>

<style lang="stylus" scoped>
.InAppProjectsPanel
	display flex
	flex-direction column
	gap 0.5em
	min-width 30rem

.storage
	color var(--tq-color-text-mute)
	font-size 0.9em

.list
	display flex
	flex-direction column
	gap 2px

.row
	display flex
	align-items center
	gap 0.75em
	padding 0.7em 0.9em
	border-radius var(--tq-radius-input)
	background var(--tq-color-input)

	&.current
		box-shadow inset 0 0 0 1px var(--tq-color-accent)

	.icon
		flex none
		color var(--tq-color-text-mute)

	.name
		flex 1
		overflow hidden
		text-overflow ellipsis
		white-space nowrap
		display flex
		align-items center
		gap 0.4em

	.badge
		font-size 0.75em
		color var(--tq-color-on-accent)
		background var(--tq-color-accent)
		border-radius 9999px
		padding 0 0.5em

	.size
		flex none
		color var(--tq-color-text-mute)
		font-size 0.85em
		font-variant-numeric tabular-nums

	.actions
		flex none

.empty
	color var(--tq-color-text-mute)
	padding 0.5em
</style>
