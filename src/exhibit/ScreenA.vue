<script setup lang="ts">
/**
 * Screen A: loop everything shot so far — film, tests, replays and the
 * discarded takes — as one video, in the order it was shot. The video is
 * encoded in the browser (WebCodecs) and cached; while a first encode runs,
 * or if encoding isn't available, frames are swapped as images instead.
 */
import {computed, onMounted, onUnmounted, ref, watch} from 'vue'

import {
	encodeTakesToMp4,
	isEncodingSupported,
	readCachedVideo,
	writeCachedVideo,
} from './encode'
import {useExhibitStore} from './store'

const props = defineProps<{broadcast: boolean}>()

const store = useExhibitStore()
const frames = store.frames

const channel = new BroadcastChannel('koma-exhibit')

/** Re-encode at most this often once the first video exists. */
const REENCODE_MIN_INTERVAL = 10 * 60 * 1000

const videoUrl = ref<string | null>(null)
const videoSignature = ref<string | null>(null)
const encoding = ref<{done: number; total: number} | null>(null)
const $video = ref<HTMLVideoElement | null>(null)

//------------------------------------------------------------------------------
// Image fallback (also used before the first video exists)

const index = store.shownIndex
const currentUrl = ref<string | null>(null)
const PRELOAD_AHEAD = 12
let timer: ReturnType<typeof setTimeout> | null = null
let stopped = false

async function showFrame(i: number) {
	const f = frames.value[i]
	if (!f) return
	const url = await store.frameUrl(f.filename)
	if (url && i === index.value) currentUrl.value = url
	for (let k = 1; k <= PRELOAD_AHEAD; k++) {
		const n = frames.value[(i + k) % Math.max(1, frames.value.length)]
		if (n) void store.frameUrl(n.filename)
	}
}

function tick() {
	if (stopped) return
	if (!videoUrl.value) {
		const n = frames.value.length
		if (n > 0) {
			index.value = (index.value + 1) % n
			void showFrame(index.value)
			announce(index.value)
		}
	}
	timer = setTimeout(tick, 1000 / store.fps.value)
}

function announce(i: number) {
	if (!props.broadcast) return
	channel.postMessage({type: 'frame', index: i, total: frames.value.length})
}

//------------------------------------------------------------------------------
// Video

let encodeAbort: AbortController | null = null
let lastEncodeAt = 0

async function ensureVideo() {
	const sig = store.framesSignature.value
	const list = frames.value
	if (list.length === 0 || !isEncodingSupported()) return
	if (videoSignature.value === sig) return

	const cached = await readCachedVideo(sig)
	if (cached) {
		setVideo(cached, sig)
		return
	}
	if (encoding.value) return
	if (videoUrl.value && Date.now() - lastEncodeAt < REENCODE_MIN_INTERVAL) return

	encodeAbort = new AbortController()
	encoding.value = {done: 0, total: list.length}
	try {
		const blob = await encodeTakesToMp4(
			list.map(f => ({blob: () => store.frameBlob(f.filename)})),
			{
				fps: store.fps.value,
				width: 1920,
				height: 1280,
				signal: encodeAbort.signal,
				onProgress: (done, total) => {
					encoding.value = {done, total}
				},
			}
		)
		await writeCachedVideo(sig, blob)
		lastEncodeAt = Date.now()
		setVideo(blob, sig)
	} catch (e) {
		// eslint-disable-next-line no-console
		console.warn('[exhibit] encode failed', e)
	} finally {
		encoding.value = null
		encodeAbort = null
	}
}

function setVideo(blob: Blob, sig: string) {
	if (videoUrl.value) URL.revokeObjectURL(videoUrl.value)
	videoUrl.value = URL.createObjectURL(blob)
	videoSignature.value = sig
}

/** Map the video time to the take being shown, for screen B. */
function onTimeUpdate() {
	const v = $video.value
	if (!v) return
	const i = Math.min(frames.value.length - 1, Math.floor(v.currentTime * store.fps.value))
	if (i >= 0 && i !== index.value) {
		index.value = i
		announce(i)
	}
}

let timeTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
	void showFrame(0)
	timer = setTimeout(tick, 1000 / store.fps.value)
	// `timeupdate` is too coarse (~4 Hz); poll at frame rate.
	timeTimer = setInterval(onTimeUpdate, 1000 / store.fps.value)
})

onUnmounted(() => {
	stopped = true
	if (timer) clearTimeout(timer)
	if (timeTimer) clearInterval(timeTimer)
	encodeAbort?.abort()
	channel.close()
})

watch(store.framesSignature, () => void ensureVideo(), {immediate: true})
// A periodic nudge so a rate-limited re-encode eventually happens.
const nudge = setInterval(() => void ensureVideo(), 60 * 1000)
onUnmounted(() => clearInterval(nudge))

watch(
	() => frames.value.length,
	n => {
		if (index.value >= n) index.value = 0
	}
)

const current = computed(() => frames.value[index.value] ?? null)
</script>

<template>
	<div class="ScreenA">
		<video
			v-if="videoUrl"
			ref="$video"
			class="frame"
			:src="videoUrl"
			autoplay
			loop
			muted
			playsinline
		/>
		<img v-else-if="currentUrl" :src="currentUrl" class="frame" />
		<div v-else class="empty">
			<span v-if="frames.length === 0">No takes yet</span>
		</div>
		<div class="counter mono">
			<template v-if="encoding">
				encoding {{ encoding.done }} / {{ encoding.total }} ·
			</template>
			<template v-if="current">{{ index + 1 }} / {{ frames.length }}</template>
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
	width: 100%;
	height: 100%;
	object-fit: contain;
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
