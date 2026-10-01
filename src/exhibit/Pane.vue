<script setup lang="ts">
/**
 * Contents of one grid cell on screen B. Everything reads the exhibit store;
 * cells that need the live relay from the shooting machine show a
 * placeholder until the relay exists (§15.2).
 */
import QRCode from 'qrcode'
import {computed, onUnmounted, ref, shallowRef, watch} from 'vue'

import type {CompactToolpath} from '@/utils/fluidnc/toolpath.worker'
import {clearToolpathCache, parseToolpathCached} from '@/utils/fluidnc/toolpathParser'

import {keepLastLive, useLastLive} from './lastLive'
import {useExhibitRelay} from './relay'
import type {PaneKind} from './SplitNode.vue'
import {useExhibitStore} from './store'
import {ToolpathRenderer} from './toolpathView'

const props = defineProps<{kind: PaneKind}>()

const store = useExhibitStore()
const relay = useExhibitRelay()

//------------------------------------------------------------------------------
// Live state from the shooting machine (null while it is offline)

interface MachineLive {
	connected: boolean
	state: string | null
	mpos: Record<string, number>
	wpos: Record<string, number>
	alarm: {code: number; message: string} | null
	busy: boolean
	progress: {index: number; total: number} | null
	t: number
}

interface SequenceLive {
	running: boolean
	continuous: boolean
	step: string | null
	message: string | null
	progress: {frame: number; step: string; done: string[]; status: string; error?: string; updatedAt: number} | null
	filmLift: number
	captureFrame: number
	captureLayer: number
	gcode: {frame: number; path: string; index: number; total: number} | null
	t: number
}

const online = relay.captureOnline
const liveMill = relay.topic<MachineLive>('machine:mill')
const liveRig = relay.topic<MachineLive>('machine:rig')
const liveSequence = relay.topic<SequenceLive>('sequence')
const live = <T,>(entry: {value: {data: T} | null}) => (online.value ? (entry.value?.data ?? null) : null)

const lastSeen = computed(() => {
	const t = relay.captureLastSeen.value
	return t ? new Date(t).toLocaleString('ja-JP', {hour12: false}) : null
})
const DEVLOG_URL = 'https://baku89.com/assembling-anew'

const titles: Record<PaneKind, string> = {
	meta: 'FRAME',
	sequence: 'SEQUENCE',
	gcode: 'G-CODE',
	scene: 'BOX RIG / MILL',
	live: 'LIVE VIEW',
	qr: 'DEVLOG',
}

const shown = store.shown

const shownKind = computed(() => {
	const f = shown.value
	if (!f) return '—'
	if (f.take === 'trash') return 'retake (discarded)'
	if (f.take === 'previz') return 'previz (not shot yet)'
	return store.project.value?.layers?.[f.layer]?.name ?? (f.layer === 0 ? 'Main' : `Layer ${f.layer}`)
})

const shownDate = computed(() => {
	const t = shown.value?.captureDate
	return t ? new Date(t).toLocaleString('ja-JP', {hour12: false}) : '—'
})

const exposure = computed(() => {
	const c = shown.value?.cameraConfigs as Record<string, unknown> | undefined
	if (!c) return '—'
	const parts: string[] = []
	if (c.aperture !== undefined) parts.push(`f/${c.aperture}`)
	if (c.shutterSpeed !== undefined) parts.push(`${c.shutterSpeed}s`)
	if (c.iso !== undefined) parts.push(`ISO ${c.iso}`)
	if (c.colorTemperature !== undefined) parts.push(`${c.colorTemperature}K`)
	return parts.join(' · ') || '—'
})

const fmt = (v: number | undefined, d = 1) => (v === undefined ? '—' : v.toFixed(d))

const rig = computed(() => shown.value?.rig ?? null)

const sequence = computed(
	() => live(liveSequence)?.progress ?? store.project.value?.addsub?.sequence ?? null
)
const filmLift = computed(() => {
	const a = store.project.value?.addsub
	return live(liveSequence)?.filmLift ?? a?.filmLift ?? (a?.kBase === undefined ? 0 : 60 * a.kBase)
})
const captureFrame = computed(
	() => live(liveSequence)?.captureFrame ?? store.project.value?.captureShot?.frame ?? null
)
const sequenceMessage = computed(() => live(liveSequence)?.message ?? null)

const STEPS = [
	'cut',
	'extend',
	'rig',
	'led',
	'settle',
	'capture',
	'park',
	'retract',
]

function stepState(step: string) {
	const ls = live(liveSequence)
	if (ls?.running) {
		const s = ls.progress
		if (s?.done.includes(step)) return 'done'
		if (ls.step === step) return 'current'
		return 'todo'
	}
	const s = sequence.value
	if (!s) return 'todo'
	if (s.done.includes(step)) return 'done'
	if (s.step === step) return s.status === 'running' ? 'current' : 'halted'
	return 'todo'
}

//------------------------------------------------------------------------------
// G-CODE: the cut of the frame being shown, from previz/gcode next to the
// project, drawn as an annotated wireframe.
const $gcode = ref<HTMLCanvasElement | null>(null)
const $gcodeLabels = ref<HTMLCanvasElement | null>(null)
// shallowRef: the parsed path is tens of thousands of numbers — never make
// it deeply reactive.
const gcodeScene = shallowRef<CompactToolpath | null>(null)
/** The path whose toolpath `gcodeScene` holds (for the caption). */
const gcodeShownPath = ref<string | null>(null)
/** The cut being streamed right now, when the shooting machine is cutting. */
const liveCut = computed(() => live(liveSequence)?.gcode ?? null)
const gcodePath = computed(() => {
	if (liveCut.value) return liveCut.value.path
	return shown.value
		? store.gcodePathFor(shown.value.frame, shown.value.take === 'previz' ? 0 : shown.value.layer)
		: null
})
/** Lines already sent to the mill (−1 = not cutting: draw the whole path plain). */
const sentLines = computed(() => liveCut.value?.index ?? -1)

/**
 * Screen A plays at 18 fps and every film frame has its own cut; swapping
 * the view that often is unreadable and, worse, made the page stutter
 * (fetch + parse + GPU upload per frame). Follow the shown frame at most
 * every SWAP_MS instead — leading edge, then the latest frame at the
 * trailing edge — and parse in a worker.
 */
const SWAP_MS = 400
let swapTimer: ReturnType<typeof setTimeout> | null = null
let lastSwapAt = 0
let swapGeneration = 0

async function loadGcode(rel: string | null) {
	const gen = ++swapGeneration
	lastSwapAt = performance.now()
	if (!rel) {
		gcodeScene.value = null
		gcodeShownPath.value = null
		return
	}
	const scene = await parseToolpathCached(rel, () => store.readText(rel))
	if (gen !== swapGeneration) return
	gcodeScene.value = scene
	gcodeShownPath.value = rel
}

function requestGcode(rel: string | null) {
	if (rel === gcodeShownPath.value && rel !== null) {
		if (swapTimer) clearTimeout(swapTimer)
		swapTimer = null
		return
	}
	const wait = SWAP_MS - (performance.now() - lastSwapAt)
	if (wait <= 0 && !swapTimer) {
		void loadGcode(rel)
		return
	}
	if (swapTimer) return
	swapTimer = setTimeout(() => {
		swapTimer = null
		void loadGcode(gcodePath.value)
	}, Math.max(0, wait))
}

watch(gcodePath, rel => requestGcode(rel), {immediate: true})
// previz/frames.json (and so the G-code files) changed: drop parsed paths.
watch(store.previzModified, () => {
	clearToolpathCache()
	gcodeShownPath.value = null
	requestGcode(gcodePath.value)
})

let renderer: ToolpathRenderer | null = null
let raf = 0
const t0 = performance.now()

function ensureRenderer() {
	if (renderer || !$gcode.value || !$gcodeLabels.value) return renderer
	renderer = new ToolpathRenderer($gcode.value, $gcodeLabels.value, {
		font: "'Fira Code', ui-monospace, monospace",
		color: '#ffffff',
		dim: '#707070',
		accent: '#ffffff',
	})
	// A scene may have arrived before the canvases were mounted.
	renderer.setScene(gcodeScene.value, sentLines.value)
	return renderer
}

watch(gcodeScene, scene => {
	ensureRenderer()?.setScene(scene, sentLines.value)
})
watch(sentLines, sent => {
	ensureRenderer()?.setSent(sent)
})

function tickGcode() {
	raf = requestAnimationFrame(tickGcode)
	const r = ensureRenderer()
	if (!r || !gcodeScene.value) return
	r.render((performance.now() - t0) / 1000)
}

//------------------------------------------------------------------------------
// LIVE VIEW: the camera's MediaStream over WebRTC

const $video = shallowRef<HTMLVideoElement | null>(null)
let releaseLive: (() => void) | null = null
if (props.kind === 'live') releaseLive = relay.requestLive()
watch(
	[$video, relay.liveStream],
	([video, stream]) => {
		if (!video || video.srcObject === stream) return
		// The stream is going away: hold on to the picture it leaves behind.
		if (!stream) keepLastLive(video)
		video.srcObject = stream
	},
	{immediate: true}
)

// The picture shown while there is no stream (lastLive.ts). Also saved every
// few seconds while live, for a reload or a power cut on this machine.
const lastLive = useLastLive()
const lastLiveTime = computed(() =>
	lastLive.value ? new Date(lastLive.value.t).toLocaleString('ja-JP', {hour12: false}) : null
)
const KEEP_LIVE_MS = 10_000
const keepTimer =
	props.kind === 'live'
		? setInterval(() => {
				if ($video.value && relay.liveActive.value) keepLastLive($video.value)
			}, KEEP_LIVE_MS)
		: undefined

onUnmounted(() => {
	clearInterval(keepTimer)
	releaseLive?.()
})

//------------------------------------------------------------------------------
// BOX RIG / MILL: live positions, else the pose of the shown take

const fmtAxis = (k: string, v: number | undefined) =>
	v === undefined ? '—' : v.toFixed(k === 'a' || k === 'b' || k === 'c' ? 2 : 1)

const rigLive = computed(() => live(liveRig))
const millLive = computed(() => live(liveMill))
const RIG_AXES = ['x', 'y', 'z', 'a', 'b', 'c']
const MILL_AXES = ['x', 'y', 'z']
if (props.kind === 'gcode') raf = requestAnimationFrame(tickGcode)
onUnmounted(() => {
	cancelAnimationFrame(raf)
	if (swapTimer) clearTimeout(swapTimer)
	swapGeneration++
	renderer?.dispose()
})

const $qr = ref<HTMLCanvasElement | null>(null)
watch(
	$qr,
	canvas => {
		if (!canvas) return
		void QRCode.toCanvas(canvas, DEVLOG_URL, {
			margin: 1,
			width: 160,
			color: {dark: '#ffffffff', light: '#00000000'},
		})
	},
	{immediate: true}
)
</script>

<template>
	<div class="Pane" :data-kind="kind">
		<div class="title mono">{{ titles[props.kind] }}</div>

		<!-- FRAME -->
		<dl v-if="kind === 'meta'" class="rows">
			<dt>No.</dt>
			<dd class="mono big">
				<template v-if="shown">{{ shown.frame + 1 }}<span class="dim"> / {{ store.frames.value.length }}</span></template>
				<template v-else>—</template>
			</dd>
			<dt>Shot</dt>
			<dd class="mono">{{ shownDate }}</dd>
			<dt>Layer</dt>
			<dd class="mono">{{ shownKind }}</dd>
			<dt>Frame</dt>
			<dd class="mono">{{ shown ? shown.frame + 1 : '—' }}</dd>
			<dt>Exposure</dt>
			<dd class="mono">{{ exposure }}</dd>
			<dt>Lift</dt>
			<dd class="mono">{{ shown?.filmLift === undefined ? '—' : `${shown.filmLift} mm` }}</dd>
			<dt>Rig</dt>
			<dd class="mono small">
				<template v-if="rig">
					X {{ fmt(rig.x) }} Y {{ fmt(rig.y) }} Z {{ fmt(rig.z) }}<br />
					A {{ fmt(rig.a, 2) }} B {{ fmt(rig.b, 2) }} C {{ fmt(rig.c, 2) }}
				</template>
				<template v-else>—</template>
			</dd>
		</dl>

		<!-- SEQUENCE -->
		<div v-else-if="kind === 'sequence'" class="sequence">
			<div class="mono">
				capture frame
				<span class="big">{{ captureFrame === null ? '—' : captureFrame + 1 }}</span>
				<span class="dim"> · lift {{ filmLift }} mm</span>
			</div>
			<ol class="steps mono">
				<li v-for="s in STEPS" :key="s" :class="stepState(s)">{{ s }}</li>
			</ol>
			<div class="mono small dim">
				<template v-if="sequenceMessage">{{ sequenceMessage }}</template>
				<template v-else-if="sequence">
					{{ sequence.status }}
					<template v-if="sequence.error"> — {{ sequence.error }}</template>
					· {{ new Date(sequence.updatedAt).toLocaleTimeString('ja-JP', {hour12: false}) }}
				</template>
				<template v-else>idle</template>
				<template v-if="!online"> · offline</template>
			</div>
		</div>

		<!-- G-CODE: this frame's cut, from previz/gcode -->
		<div v-else-if="kind === 'gcode'" class="gcode">
			<div v-show="gcodeScene" class="gcode-view">
				<canvas ref="$gcode" class="gcode-canvas" />
				<canvas ref="$gcodeLabels" class="gcode-canvas" />
			</div>
			<div v-if="!gcodeScene" class="placeholder mono">
				<div class="dim">{{ gcodePath ? 'loading…' : 'no cut on this frame' }}</div>
			</div>
			<div v-if="gcodeScene && gcodeShownPath" class="mono small dim caption">
				{{ gcodeShownPath.replace(/^previz\//, '') }} · {{ gcodeScene.lineCount }} lines ·
				{{ gcodeScene.cutLength.toFixed(0) }} mm
				<template v-if="liveCut">
					· <span class="bright">cutting frame {{ liveCut.frame + 1 }} · line {{ liveCut.index }} / {{ liveCut.total }}</span>
				</template>
			</div>
		</div>

		<!-- SCENE: live machine positions from the relay, else the shown take's pose -->
		<div v-else-if="kind === 'scene'" class="machines mono">
			<div class="machine">
				<div class="machine-head">
					<span>BOX RIG</span>
					<span class="dim small">
						{{ rigLive ? (rigLive.connected ? (rigLive.state ?? '…') : 'not connected') : 'offline' }}
					</span>
				</div>
				<div class="scene-axes">
					<div v-for="k in RIG_AXES" :key="k" class="axis">
						<span class="dim">{{ k.toUpperCase() }}</span>
						<span :class="{dim: !rigLive}">
							{{ fmtAxis(k, rigLive?.connected ? rigLive.mpos[k] : rig?.[k]) }}
						</span>
					</div>
				</div>
			</div>
			<div class="machine">
				<div class="machine-head">
					<span>MILL</span>
					<span class="dim small">
						{{ millLive ? (millLive.connected ? (millLive.state ?? '…') : 'not connected') : 'offline' }}
						<template v-if="millLive?.progress"> · {{ millLive.progress.index }} / {{ millLive.progress.total }}</template>
					</span>
				</div>
				<div class="scene-axes">
					<div v-for="k in MILL_AXES" :key="k" class="axis">
						<span class="dim">{{ k.toUpperCase() }}</span>
						<span :class="{dim: !millLive?.connected}">
							{{ fmtAxis(k, millLive?.connected ? millLive.mpos[k] : undefined) }}
						</span>
					</div>
				</div>
			</div>
			<div v-if="!online" class="dim small">
				shooting machine offline<template v-if="lastSeen"> · last seen {{ lastSeen }}</template>
				<template v-if="rig"> · showing the pose of the frame on screen A</template>
			</div>
		</div>

		<!-- LIVE VIEW: WebRTC from the shooting machine -->
		<div v-else-if="kind === 'live'" class="live">
			<video
				v-show="relay.liveStream.value"
				ref="$video"
				class="live-video"
				autoplay
				muted
				playsinline
				:class="{off: !relay.liveActive.value}"
			/>
			<img v-if="!relay.liveStream.value && lastLive" class="live-video off" :src="lastLive.url" />
			<div v-if="!relay.liveActive.value" class="placeholder mono live-overlay">
				<div class="dim">
					<template v-if="!online">
						shooting machine offline<template v-if="lastSeen"><br />last seen {{ lastSeen }}</template>
					</template>
					<template v-else>live view is off on the shooting machine</template>
					<template v-if="!relay.liveStream.value && lastLiveTime"><br />last picture {{ lastLiveTime }}</template>
				</div>
			</div>
		</div>

		<!-- QR -->
		<div v-else-if="kind === 'qr'" class="qr">
			<canvas ref="$qr" />
			<div class="mono small dim">baku89.com/assembling-anew</div>
		</div>
	</div>
</template>

<style scoped>
.Pane {
	width: 100%;
	height: 100%;
	box-sizing: border-box;
	/* Only top + left: neighbours share one line, never two. The grid pulls
	   the outermost top/left lines off-screen. */
	border: 0;
	border-top: 1px solid #fff;
	border-left: 1px solid #fff;
	padding: 0.7rem 1rem;
	position: relative;
	overflow: hidden;
	display: flex;
	flex-direction: column;
	gap: 0.6rem;
}

.title {
	font-size: 0.7rem;
	letter-spacing: 0.2em;
	color: #fff;
}

.rows {
	display: grid;
	grid-template-columns: auto 1fr;
	gap: 0.3rem 1rem;
	margin: 0;
	align-content: start;
}

dt {
	color: rgba(255, 255, 255, 0.55);
	font-size: 0.8rem;
	text-transform: uppercase;
	letter-spacing: 0.1em;
}

dd {
	margin: 0;
}

.big {
	font-size: 1.6rem;
}

.small {
	font-size: 0.8rem;
}

.dim {
	color: rgba(255, 255, 255, 0.55);
}

.sequence {
	display: flex;
	flex-direction: column;
	gap: 0.6rem;
}

.steps {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-wrap: wrap;
	gap: 0.3rem 0.8rem;
	font-size: 0.85rem;
}

.steps li {
	color: rgba(255, 255, 255, 0.4);
}

.steps li::before {
	content: '○ ';
}

.steps li.done {
	color: #fff;
}

.steps li.done::before {
	content: '● ';
}

.steps li.current {
	color: #fff;
}

.steps li.current::before {
	content: '◐ ';
}

.steps li.halted {
	color: #f90;
}

.steps li.halted::before {
	content: '◐ ';
}

.placeholder {
	flex: 1 1 0;
	display: flex;
	flex-direction: column;
	justify-content: center;
	align-items: center;
	gap: 0.8rem;
	font-size: 0.85rem;
}

.scene-axes {
	display: flex;
	flex-wrap: wrap;
	gap: 0.6rem 1.2rem;
	font-size: 1.1rem;
}

.machines {
	flex: 1 1 0;
	min-height: 0;
	display: flex;
	flex-direction: column;
	justify-content: center;
	gap: 1.2rem;
}

.machine {
	display: flex;
	flex-direction: column;
	gap: 0.4rem;
}

.machine-head {
	display: flex;
	justify-content: space-between;
	font-size: 0.8rem;
	letter-spacing: 0.15em;
}

.bright {
	color: #fff;
}

.live {
	flex: 1 1 0;
	min-height: 0;
	position: relative;
	display: flex;
}

.live-video {
	width: 100%;
	height: 100%;
	object-fit: contain;
	background: #000;
}

.live-video.off {
	opacity: 0.25;
}

.live-overlay {
	position: absolute;
	inset: 0;
	text-align: center;
}

.axis {
	display: flex;
	flex-direction: column;
	align-items: center;
}

.gcode {
	flex: 1 1 0;
	min-height: 0;
	display: flex;
	flex-direction: column;
	gap: 0.4rem;
}

.gcode-view {
	flex: 1 1 0;
	min-height: 0;
	position: relative;
}

.gcode-canvas {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
}

.caption {
	flex: 0 0 auto;
}

.qr {
	flex: 1 1 0;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 0.5rem;
}

.qr canvas {
	max-width: 100%;
	image-rendering: pixelated;
}

.qr .small {
	text-align: center;
	overflow-wrap: anywhere;
	padding: 0 0.3rem;
}
</style>
