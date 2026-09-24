<script setup lang="ts">
/**
 * Retakes: every shot displaced from the timeline (deleted, or replaced by a
 * re-shoot) with where and when it was taken, Dragonframe-style. Nothing here
 * is ever lost until explicitly purged (purge isn't offered yet); "Restore"
 * puts a take back — swapping with whatever is in that cell now.
 */
import {useTweeq} from 'tweeq'
import {computed} from 'vue'

import {type TrashedShot, useProjectStore} from '@/stores/project'
import {useViewportStore} from '@/stores/viewport'

import TrashRow from './TrashRow.vue'

const Tq = useTweeq()
const project = useProjectStore()
const viewport = useViewportStore()

const LIMIT = 60

const showAll = Tq.config.ref('trashPanel.showAll', false)

/** Newest displacement first. */
const takes = computed(() =>
	[...project.trash]
		.sort((a, b) => b.deletedAt - a.deletedAt)
		.slice(0, showAll.value ? Infinity : LIMIT)
)

function restoreHere(t: TrashedShot) {
	project.restoreTrashed(t, viewport.currentFrame, viewport.currentLayer)
}

function restoreOrigin(t: TrashedShot) {
	project.restoreTrashed(t)
	viewport.setCurrentFrame(t.frame)
	viewport.setCurrentLayer(t.layer)
}
</script>

<template>
	<Tq.ParameterGroup name="trash" label="Retakes" icon="mdi:history">
		<template #headingRight>
			<span class="count">{{ project.trash.length }}</span>
		</template>
		<li v-if="takes.length === 0" class="empty">
			No displaced takes. Deleted or re-shot frames show up here.
		</li>
		<li v-else class="list">
			<TrashRow
				v-for="t in takes"
				:key="t.shot.lv"
				:take="t"
				:layerLabel="project.layers[t.layer]?.label"
				@restore="restoreOrigin(t)"
				@restoreHere="restoreHere(t)"
			/>
			<button
				v-if="project.trash.length > LIMIT"
				class="more"
				@click="showAll = !showAll"
			>
				{{ showAll ? 'Show fewer' : `Show all ${project.trash.length}` }}
			</button>
		</li>
	</Tq.ParameterGroup>
</template>

<style lang="stylus" scoped>
.count
	font-size 0.85em
	color var(--tq-color-text-mute)

.empty
	grid-column 1 / 3
	list-style none
	color var(--tq-color-text-mute)
	font-size 0.85em
	padding 0 0 var(--tq-gap-group) var(--tq-gap-section)

.list
	grid-column 1 / 3
	list-style none
	display flex
	flex-direction column
	gap var(--tq-gap-group)
	max-height 24em
	overflow-y auto
	padding 0 0 var(--tq-gap-group) var(--tq-gap-section)

.more
	align-self flex-start
	background var(--tq-color-input)
	height var(--tq-input-height)
	padding 0 1em
	border-radius 9999px
	font-size 0.85em

	&:hover
		background var(--tq-color-input-hover)
</style>
