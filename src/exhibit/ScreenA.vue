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
import {type ExhibitFrame, useExhibitStore} from './store'

const props = defineProps<{broadcast: boolean}>()

const store = useExhibitStore()
const frames = store.frames

const channel = new BroadcastChannel('koma-exhibit')

/** Re-encode at most this often once the first video exists. */
const REENCODE_MIN_INTERVAL = 10 * 60 * 1000

const videoUrl = ref<string | null>(null)
const videoSignature = ref<string | null>(null)
/**
 * The take list the playing video was encoded from, and its rate. The store's
 * list may move on while this video still plays (a new take, a re-encode in
 * progress), so the playhead is mapped through this list and matched to the
 * current one by filename.
 */
let videoFrames: ExhibitFrame[] = []
let videoFps = 18
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
	if (!videoUrl.value && !paused.value) {
		const n = frames.value.length
		if (n > 0) {
			index.value = (index.value + 1) % n
			void showFrame(index.value)
			announce()
		}
	}
	timer = setTimeout(tick, 1000 / store.fps.value)
}

/** Tell screen B (in its own window) what is on screen, by index and identity. */
function announce() {
	if (!props.broadcast) return
	const f = frames.value[index.value]
	if (!f) return
	channel.postMessage({
		type: 'frame',
		index: index.value,
		filename: f.filename,
		total: frames.value.length,
	})
}

//------------------------------------------------------------------------------
// Pause (space, from either window — Exhibit.vue posts `toggle-pause`). The
// take stays on screen and screen B stays on it. Resumes by itself after a
// while, so a forgotten pause doesn't leave the exhibit frozen.

const PAUSE_TIMEOUT = 5 * 60 * 1000

const paused = ref(false)
let pauseTimer: ReturnType<typeof setTimeout> | null = null

function setPaused(value: boolean) {
	paused.value = value
	if (pauseTimer) clearTimeout(pauseTimer)
	pauseTimer = value ? setTimeout(() => setPaused(false), PAUSE_TIMEOUT) : null

	const v = $video.value
	if (value) v?.pause()
	else {
		void v?.play().catch(() => {})
		// Pick up a video that became ready, or due, while paused.
		if (pendingVideo) setVideo(...pendingVideo)
		pendingVideo = null
		void ensureVideo()
	}
}

channel.onmessage = e => {
	if (e.data?.type === 'toggle-pause') setPaused(!paused.value)
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
	// Swapping the video would jump off the paused take.
	if (paused.value) return

	const cached = await readCachedVideo(sig)
	if (cached) {
		setVideo(cached, sig, list, store.fps.value)
		return
	}
	if (encoding.value) return
	if (videoUrl.value && Date.now() - lastEncodeAt < REENCODE_MIN_INTERVAL) return

	encodeAbort = new AbortController()
	encoding.value = {done: 0, total: list.length}
	const fps = store.fps.value
	try {
		const blob = await encodeTakesToMp4(
			list.map(f => ({blob: () => store.frameBlob(f.filename)})),
			{
				fps,
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
		setVideo(blob, sig, list, fps)
	} catch (e) {
		// eslint-disable-next-line no-console
		console.warn('[exhibit] encode failed', e)
	} finally {
		encoding.value = null
		encodeAbort = null
	}
}

/** A video that became ready while paused; shown on resume. */
let pendingVideo: Parameters<typeof setVideo> | null = null

function setVideo(blob: Blob, sig: string, list: ExhibitFrame[], fps: number) {
	// Swapping the video would jump off the paused take.
	if (paused.value) {
		pendingVideo = [blob, sig, list, fps]
		return
	}
	if (videoUrl.value) URL.revokeObjectURL(videoUrl.value)
	videoUrl.value = URL.createObjectURL(blob)
	videoSignature.value = sig
	videoFrames = list
	videoFps = fps
}

/** Map the video time to the take being shown, for the counter and screen B. */
function onTimeUpdate() {
	const v = $video.value
	if (!v || videoFrames.length === 0) return
	const k = Math.min(videoFrames.length - 1, Math.floor(v.currentTime * videoFps))
	if (k < 0) return
	const take = videoFrames[k]
	const i = store.indexByFilename.value.get(take.filename) ?? Math.min(k, frames.value.length - 1)
	if (i >= 0 && i !== index.value) {
		index.value = i
		announce()
	}
}

let timeTimer: ReturnType<typeof setInterval> | null = null
let heartbeat: ReturnType<typeof setInterval> | null = null

onMounted(() => {
	void showFrame(0)
	timer = setTimeout(tick, 1000 / store.fps.value)
	// `timeupdate` is too coarse (~4 Hz); poll at frame rate.
	timeTimer = setInterval(onTimeUpdate, 1000 / store.fps.value)
	// Heartbeat so a screen B opened later (or one that missed a message)
	// catches up within a second.
	heartbeat = setInterval(announce, 1000)
})

onUnmounted(() => {
	stopped = true
	if (timer) clearTimeout(timer)
	if (pauseTimer) clearTimeout(pauseTimer)
	if (timeTimer) clearInterval(timeTimer)
	if (heartbeat) clearInterval(heartbeat)
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
			<template v-if="paused">❙❙ paused · </template>
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

/*
 * Absolutely sized: as a grid item, `height: 100%` resolved against an
 * auto row, so a 3:2 video in a wider pane took its height from the width
 * and overflowed the bottom.
 */
.frame {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	object-fit: cover;
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
