<script setup lang="ts">
import {asyncComputed} from '@vueuse/core'
import {useTweeq} from 'tweeq'
import {computed} from 'vue'

import type {TrashedShot} from '@/stores/project'
import {resolveAssetUrl} from '@/utils'

const props = defineProps<{
	take: TrashedShot
	layerLabel?: string
}>()

defineEmits<{
	restore: []
	restoreHere: []
}>()

const Tq = useTweeq()

const url = asyncComputed(() => resolveAssetUrl(props.take.shot.lv), undefined)

function fmtTime(t: number | undefined) {
	if (!t) return '—'
	const d = new Date(t)
	return d.toLocaleString('ja-JP', {
		hour12: false,
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	})
}

const where = computed(() => {
	const l = props.layerLabel ? `${props.take.layer} · ${props.layerLabel}` : `${props.take.layer}`
	return `f${props.take.frame} L${l}`
})
</script>

<template>
	<div class="TrashRow">
		<img v-if="url" class="thumb" :src="url" />
		<div v-else class="thumb placeholder" />
		<div class="meta">
			<div class="where tq-font-numeric">{{ where }}</div>
			<div class="when">
				shot {{ fmtTime(take.shot.captureDate) }} · out {{ fmtTime(take.deletedAt) }}
			</div>
		</div>
		<div class="actions">
			<Tq.InputButton
				icon="mdi:backup-restore"
				narrow
				subtle
				:tooltip="`Restore to frame ${take.frame} (swaps with the current take there)`"
				@click="$emit('restore')"
			/>
			<Tq.InputButton
				icon="mdi:import"
				narrow
				subtle
				tooltip="Restore to the current frame / layer"
				@click="$emit('restoreHere')"
			/>
		</div>
	</div>
</template>

<style lang="stylus" scoped>
.TrashRow
	display grid
	grid-template-columns 3.6em 1fr auto
	align-items center
	gap var(--tq-gap-control)

.thumb
	width 3.6em
	aspect-ratio 3 / 2
	object-fit cover
	border-radius calc(var(--tq-radius-input) / 2)
	background var(--tq-color-input)

.meta
	min-width 0
	line-height 1.3

.where
	font-size 0.9em

.when
	font-size 0.75em
	color var(--tq-color-text-mute)
	white-space nowrap
	overflow hidden
	text-overflow ellipsis

.actions
	display flex
	gap 2px
</style>
