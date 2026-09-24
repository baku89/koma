<script setup lang="ts">
/**
 * Screen A: loop the frames shot so far at the project's frame rate. Frames
 * are decoded ahead of the playhead only (thousands of frames, §15.2).
 */
import {computed, onMounted, onUnmounted, ref, watch} from 'vue'

import {useExhibitStore} from './store'

const props = defineProps<{broadcast: boolean}>()

const store = useExhibitStore()
const frames = store.frames

const index = store.shownIndex
const currentUrl = ref<string | null>(null)
const $img = ref<HTMLImageElement | null>(null)

const channel = new BroadcastChannel('koma-exhibit')

const current = computed(() => frames.value[index.value] ?? null)

const PRELOAD_AHEAD = 12

let timer: ReturnType<typeof setTimeout> | null = null
let stopped = false

async function showFrame(i: number) {
	const f = frames.value[i]
	if (!f) return
	const url = await store.frameUrl(f.filename)
	if (url && i === index.value) {
		currentUrl.value = url
		if (props.broadcast) {
			channel.postMessage({type: 'frame', frame: f.frame, index: i, total: frames.value.length})
		}
	}
	// Warm the cache ahead.
	for (let k = 1; k <= PRELOAD_AHEAD; k++) {
		const n = frames.value[(i + k) % Math.max(1, frames.value.length)]
		if (n) void store.frameUrl(n.filename)
	}
}

function tick() {
	if (stopped) return
	const n = frames.value.length
	if (n > 0) {
		index.value = (index.value + 1) % n
		void showFrame(index.value)
	}
	timer = setTimeout(tick, 1000 / store.fps.value)
}

onMounted(() => {
	void showFrame(0)
	timer = setTimeout(tick, 1000 / store.fps.value)
})

onUnmounted(() => {
	stopped = true
	if (timer) clearTimeout(timer)
	channel.close()
})

// If the project shrinks (undo on the shooting machine) keep the index valid.
watch(
	() => frames.value.length,
	n => {
		if (index.value >= n) index.value = 0
	}
)
</script>

<template>
	<div class="ScreenA">
		<img v-if="currentUrl" ref="$img" :src="currentUrl" class="frame" />
		<div v-else class="empty">
			<span v-if="frames.length === 0">No frames yet</span>
		</div>
		<div class="counter mono">
			<template v-if="current">{{ current.frame + 1 }} / {{ frames.length }}</template>
		</div>
	</div>
</template>

<style scoped>
.ScreenA {
	position: relative;
	background: #000;
	display: grid;
	place-items: center;
	overflow: hidden;
}

.frame {
	max-width: 100%;
	max-height: 100%;
	object-fit: contain;
	image-rendering: auto;
}

.empty {
	color: #555;
}

.counter {
	position: absolute;
	right: 1rem;
	bottom: 0.8rem;
	font-size: 0.8rem;
	color: #666;
}
</style>
