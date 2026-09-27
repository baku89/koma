<script setup lang="ts">
/**
 * Screen B: the blueprint-like grid. The split tree is data so cells can be
 * rearranged or swapped without touching markup (§15.2).
 */
import {onUnmounted, ref} from 'vue'

import {useExhibitRelay} from './relay'
import SplitNode, {type LayoutNode} from './SplitNode.vue'
import {useExhibitStore} from './store'

const props = defineProps<{follow: boolean}>()

const store = useExhibitStore()
const relay = useExhibitRelay()

// Follow screen A's playhead: in its own window via the broadcast, side by
// side with A through the shared store (A writes shownIndex directly).
const channel = new BroadcastChannel('koma-exhibit')
channel.onmessage = e => {
	if (props.follow && e.data?.type === 'frame') store.shownIndex.value = e.data.index
}

onUnmounted(() => {
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
				{
					split: 'col',
					ratio: 2,
					children: [
						{pane: 'meta', ratio: 1},
						{pane: 'sequence', ratio: 1},
					],
				},
				{pane: 'live', ratio: 3},
			],
		},
		{
			split: 'row',
			ratio: 2,
			children: [
				{pane: 'scene', ratio: 3},
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
			<span :class="{live: relay.captureOnline.value}" class="link">
				{{ relay.captureOnline.value ? '● LIVE' : '○ OFFLINE' }}
			</span>
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
	color: #fff;
	box-sizing: border-box;
	overflow: hidden;
}

.head {
	display: flex;
	justify-content: space-between;
	font-size: 0.85rem;
	letter-spacing: 0.15em;
	color: #fff;
	border-bottom: 1px solid #fff;
	padding: 0.7rem 1rem;
}

.link {
	color: rgba(255, 255, 255, 0.45);
}

.link.live {
	color: #fff;
}

/* Pane borders (top + left of each pane) are the only lines: shift the grid
   up/left by one so the outermost lines fall on the header's rule and the
   screen edge (no surrounding frame). */
.grid {
	flex: 1 1 0;
	min-height: 0;
	display: flex;
	margin: -1px 0 0 -1px;
}

.grid > :deep(.SplitNode) {
	flex: 1 1 0;
}
</style>
