<script setup lang="ts">
/**
 * Screen B: the blueprint-like grid. The split tree is data so cells can be
 * rearranged or swapped without touching markup (§15.2).
 */
import {onMounted, onUnmounted, ref} from 'vue'

import SplitNode, {type LayoutNode} from './SplitNode.vue'
import {useExhibitStore} from './store'

const props = defineProps<{follow: boolean}>()

const store = useExhibitStore()

// Follow screen A's playhead (broadcast), or run our own clock when alone.
const channel = new BroadcastChannel('koma-exhibit')
channel.onmessage = e => {
	if (e.data?.type === 'frame') store.shownIndex.value = e.data.index
}

let ownTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
	if (!props.follow) {
		ownTimer = setInterval(() => {
			const n = store.frames.value.length
			store.shownIndex.value = n ? (store.shownIndex.value + 1) % n : 0
		}, 1000 / store.fps.value)
	}
})
onUnmounted(() => {
	if (ownTimer) clearInterval(ownTimer)
	channel.close()
	clearInterval(clockTimer)
})

const layout: LayoutNode = {
	split: 'col',
	ratio: 1,
	children: [
		{
			split: 'row',
			ratio: 3,
			children: [
				{pane: 'scene', ratio: 3},
				{
					split: 'col',
					ratio: 2,
					children: [
						{pane: 'meta', ratio: 1},
						{pane: 'sequence', ratio: 1},
					],
				},
			],
		},
		{
			split: 'row',
			ratio: 2,
			children: [
				{pane: 'live', ratio: 3},
				{pane: 'gcode', ratio: 2},
				{pane: 'qr', ratio: 1},
			],
		},
	],
}

const clock = ref(new Date())
const clockTimer = setInterval(() => (clock.value = new Date()), 1000)
</script>

<template>
	<div class="ScreenB">
		<header class="head mono">
			<span>MILLING STOP-MOTION</span>
			<span>{{ store.project.value?.name ?? '—' }}</span>
			<span>{{ clock.toLocaleString('ja-JP', {hour12: false}) }}</span>
		</header>
		<div class="grid">
			<SplitNode :node="layout" />
		</div>
	</div>
</template>

<style scoped>
.ScreenB {
	display: flex;
	flex-direction: column;
	background: #000;
	color: #ddd;
	padding: 1.2rem;
	box-sizing: border-box;
	gap: 1rem;
}

.head {
	display: flex;
	justify-content: space-between;
	font-size: 0.85rem;
	letter-spacing: 0.15em;
	color: #888;
	border-bottom: 1px solid #444;
	padding-bottom: 0.6rem;
}

.grid {
	flex: 1 1 0;
	min-height: 0;
	display: flex;
}

.grid > :deep(.SplitNode) {
	flex: 1 1 0;
}
</style>
