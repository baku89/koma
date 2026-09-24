<script setup lang="ts">
/**
 * Contents of one grid cell on screen B. Everything reads the exhibit store;
 * cells that need the live relay from the shooting machine show a
 * placeholder until the relay exists (§15.2).
 */
import QRCode from 'qrcode'
import {computed, onUnmounted, ref, watch} from 'vue'

import {parseToolpath, prepareGCode} from '@/utils/fluidnc'

import type {PaneKind} from './SplitNode.vue'
import {useExhibitStore} from './store'
import {drawToolpath, type ToolpathScene} from './toolpathView'

const props = defineProps<{kind: PaneKind}>()

const store = useExhibitStore()
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

const sequence = computed(() => store.project.value?.addsub?.sequence ?? null)
const kBase = computed(() => store.project.value?.addsub?.kBase ?? 0)
const captureFrame = computed(() => store.project.value?.captureShot?.frame ?? null)

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
const gcodeScene = ref<ToolpathScene | null>(null)
const gcodePath = computed(() =>
	shown.value
		? store.gcodePathFor(shown.value.frame, shown.value.take === 'previz' ? 0 : shown.value.layer)
		: null
)
const sceneCache = new Map<string, ToolpathScene | null>()

watch(
	() => [gcodePath.value, store.previzModified.value] as const,
	async ([rel]) => {
		if (!rel) {
			gcodeScene.value = null
			return
		}
		let scene = sceneCache.get(rel)
		if (scene === undefined) {
			const text = await store.readText(rel)
			if (text) {
				const lines = prepareGCode(text).map(l => l.line)
				scene = {toolpath: parseToolpath(lines), lines}
			} else {
				scene = null
			}
			if (sceneCache.size > 20) sceneCache.clear()
			sceneCache.set(rel, scene)
		}
		if (gcodePath.value === rel) gcodeScene.value = scene
	},
	{immediate: true}
)

let raf = 0
const t0 = performance.now()
function tickGcode() {
	raf = requestAnimationFrame(tickGcode)
	const canvas = $gcode.value
	const scene = gcodeScene.value
	if (!canvas || !scene) return
	drawToolpath(canvas, scene, (performance.now() - t0) / 1000, {
		font: "'Fira Code', ui-monospace, monospace",
		color: '#e8e8e8',
		dim: '#5a5a5a',
		accent: '#ffffff',
	})
}
if (props.kind === 'gcode') raf = requestAnimationFrame(tickGcode)
onUnmounted(() => cancelAnimationFrame(raf))

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
			<dt>Block</dt>
			<dd class="mono">k = {{ shown?.kBase ?? '—' }}</dd>
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
				<span class="dim"> · k_base {{ kBase }}</span>
			</div>
			<ol class="steps mono">
				<li v-for="s in STEPS" :key="s" :class="stepState(s)">{{ s }}</li>
			</ol>
			<div class="mono small dim">
				<template v-if="sequence">
					{{ sequence.status }}
					<template v-if="sequence.error"> — {{ sequence.error }}</template>
					· {{ new Date(sequence.updatedAt).toLocaleTimeString('ja-JP', {hour12: false}) }}
				</template>
				<template v-else>idle</template>
			</div>
		</div>

		<!-- G-CODE: this frame's cut, from previz/gcode -->
		<div v-else-if="kind === 'gcode'" class="gcode">
			<canvas v-show="gcodeScene" ref="$gcode" class="gcode-canvas" />
			<div v-if="!gcodeScene" class="placeholder mono">
				<div class="dim">{{ gcodePath ? 'loading…' : 'no cut on this frame' }}</div>
			</div>
			<div v-if="gcodeScene && gcodePath" class="mono small dim caption">
				{{ gcodePath.replace(/^previz\//, '') }} · {{ gcodeScene.lines.length }} lines ·
				{{ gcodeScene.toolpath.cutLength.toFixed(0) }} mm
			</div>
		</div>

		<!-- SCENE (needs relay for live positions; last shot's pose is shown) -->
		<div v-else-if="kind === 'scene'" class="placeholder mono">
			<div v-if="rig" class="scene-axes">
				<div v-for="(v, k) in rig" :key="k" class="axis">
					<span class="dim">{{ String(k).toUpperCase() }}</span>
					<span>{{ fmt(v, k === 'a' || k === 'b' || k === 'c' ? 2 : 1) }}</span>
				</div>
			</div>
			<div class="dim small">live positions arrive over the relay</div>
		</div>

		<!-- LIVE VIEW (needs relay) -->
		<div v-else-if="kind === 'live'" class="placeholder mono">
			<div class="dim">live view — waiting for the shooting machine…</div>
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
	border: 1px solid #444;
	margin: -0.5px;
	padding: 0.7rem 0.9rem;
	position: relative;
	overflow: hidden;
	display: flex;
	flex-direction: column;
	gap: 0.6rem;
}

.title {
	font-size: 0.7rem;
	letter-spacing: 0.2em;
	color: #777;
}

.rows {
	display: grid;
	grid-template-columns: auto 1fr;
	gap: 0.3rem 1rem;
	margin: 0;
	align-content: start;
}

dt {
	color: #777;
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
	color: #777;
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
	color: #555;
}

.steps li::before {
	content: '○ ';
}

.steps li.done {
	color: #bbb;
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
	gap: 1.2rem;
	font-size: 1.1rem;
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

.gcode-canvas {
	flex: 1 1 0;
	min-height: 0;
	width: 100%;
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
