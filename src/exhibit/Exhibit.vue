<script setup lang="ts">
/**
 * Exhibition screens (ADDSUB.md §15). `?screen=a` loops the film shot so far,
 * `?screen=b` shows the blueprint-like grid of what is happening; without the
 * parameter both are shown side by side (for setup / a single monitor).
 * The A window broadcasts its playhead so B follows the same frame.
 */
import {computed, onMounted, onUnmounted, ref} from 'vue'

import ScreenA from './ScreenA.vue'
import ScreenB from './ScreenB.vue'
import {useExhibitStore} from './store'

const store = useExhibitStore()

const params = new URLSearchParams(location.search)
const screen = (params.get('screen') ?? 'ab') as 'a' | 'b' | 'ab'

const needsGesture = computed(
	() => !store.dir.value || store.permission.value !== 'granted'
)

// Setup overlay: shown until a folder is readable. Afterwards it's reachable
// by parking the mouse in the top-left corner (a gear appears), by pressing
// S, or with `?setup` in the URL.
const showSetup = ref(params.has('setup'))
const cornerHover = ref(false)

function onKey(e: KeyboardEvent) {
	if (e.key === 's' || e.key === 'S') showSetup.value = !showSetup.value
	if (e.key === 'Escape') showSetup.value = false
}

function onMouseMove(e: MouseEvent) {
	cornerHover.value = e.clientX < 80 && e.clientY < 80
}

/** Re-assign what this window shows (reloads with the new query). */
function setScreen(which: 'a' | 'b' | 'ab') {
	const p = new URLSearchParams(location.search)
	if (which === 'ab') p.delete('screen')
	else p.set('screen', which)
	p.delete('setup')
	location.search = p.toString()
}

//------------------------------------------------------------------------------
// Keep the screen on (Wake Lock) and nudge the whole page a few px every few
// minutes against burn-in (§15.3).
let wakeLock: WakeLockSentinel | null = null

async function requestWakeLock() {
	try {
		wakeLock = await navigator.wakeLock?.request('screen')
	} catch {
		wakeLock = null
	}
}

function onVisibility() {
	if (document.visibilityState === 'visible') void requestWakeLock()
}

const shift = ref({x: 0, y: 0})
let shiftTimer: ReturnType<typeof setInterval> | null = null
const SHIFT_MS = 3 * 60 * 1000

onMounted(() => {
	void store.restore()
	void requestWakeLock()
	document.addEventListener('visibilitychange', onVisibility)
	window.addEventListener('keydown', onKey)
	window.addEventListener('mousemove', onMouseMove)
	shiftTimer = setInterval(() => {
		const r = () => Math.round(Math.random() * 6 - 3)
		shift.value = {x: r(), y: r()}
	}, SHIFT_MS)
})

onUnmounted(() => {
	document.removeEventListener('visibilitychange', onVisibility)
	window.removeEventListener('keydown', onKey)
	window.removeEventListener('mousemove', onMouseMove)
	if (shiftTimer) clearInterval(shiftTimer)
	wakeLock?.release()
})

//------------------------------------------------------------------------------
// Two monitors: open A and B on separate screens, fullscreen (§15.2).
const screenCount = ref<number | null>(null)

async function placeOnScreens() {
	const w = window as any
	if (typeof w.getScreenDetails !== 'function') {
		alert('Window Management API is not available in this browser')
		return
	}
	const details = await w.getScreenDetails()
	const screens: any[] = details.screens
	screenCount.value = screens.length
	const [first, second] = screens
	const base = location.pathname
	const openOn = (s: any, which: 'a' | 'b') =>
		window.open(
			`${base}?screen=${which}`,
			`koma-exhibit-${which}`,
			`left=${s.availLeft},top=${s.availTop},width=${s.availWidth},height=${s.availHeight}`
		)
	openOn(first, 'a')
	if (second) openOn(second, 'b')
}

async function goFullscreen() {
	await document.documentElement.requestFullscreen().catch(() => {})
}
</script>

<template>
	<div
		class="Exhibit"
		:class="`screen-${screen}`"
		:style="{transform: `translate(${shift.x}px, ${shift.y}px)`}"
	>
		<ScreenA v-if="screen !== 'b'" class="pane" :broadcast="screen === 'a'" />
		<ScreenB v-if="screen !== 'a'" class="pane" :follow="screen === 'b'" />

		<button
			v-show="cornerHover && !showSetup && !needsGesture"
			class="corner"
			title="Setup (S)"
			@click="showSetup = true"
		>
			⚙ SETUP
		</button>

		<div v-if="needsGesture || showSetup" class="setup">
			<div class="setup-box">
				<h1>Milling Stop-Motion — exhibition screens</h1>
				<p v-if="!store.dir.value">
					Choose the synced koma project folder (the one holding
					<code>project.json</code>).
				</p>
				<p v-else-if="store.permission.value !== 'granted'">
					Folder <strong>{{ store.dir.value.name }}</strong> needs read
					permission again. Choose “Allow on every visit” to skip this after
					a restart.
				</p>
				<p v-else>
					Folder <strong>{{ store.dir.value.name }}</strong>
					<span v-if="store.project.value">
						· {{ store.project.value.name }} · {{ store.frames.value.length }} frames
					</span>
				</p>
				<p v-if="store.error.value" class="error">{{ store.error.value }}</p>
				<h2>Project</h2>
				<div class="buttons">
					<button
						v-if="store.dir.value && store.permission.value !== 'granted'"
						@click="store.requestPermission()"
					>
						Grant access
					</button>
					<button @click="store.pick()">Choose folder…</button>
					<button v-if="store.dir.value" @click="store.forget()">Forget folder</button>
				</div>
				<h2>This window</h2>
				<div class="buttons">
					<button :class="{on: screen === 'a'}" @click="setScreen('a')">Screen A (loop)</button>
					<button :class="{on: screen === 'b'}" @click="setScreen('b')">Screen B (data)</button>
					<button :class="{on: screen === 'ab'}" @click="setScreen('ab')">Both</button>
					<button @click="goFullscreen">Fullscreen</button>
				</div>
				<h2>Monitors</h2>
				<div class="buttons">
					<button @click="placeOnScreens">Open A and B on two screens</button>
					<button v-if="showSetup && !needsGesture" @click="showSetup = false">Close</button>
				</div>
				<p class="hint">
					Later: park the mouse in the top-left corner, press <kbd>S</kbd>, or
					add <code>?setup</code> to the URL to get back here.
				</p>
			</div>
		</div>
	</div>
</template>

<style>
html,
body {
	margin: 0;
	background: #000;
	color: #fff;
	font-family: 'Fira Code', ui-monospace, 'SF Mono', Menlo, monospace;
	font-variant-ligatures: none;
	overflow: hidden;
	cursor: none;
}

#app {
	width: 100vw;
	height: 100vh;
}

code,
kbd,
.mono {
	font-family: 'Fira Code', ui-monospace, monospace;
}
</style>

<style scoped>
.Exhibit {
	width: 100%;
	height: 100%;
	display: flex;
	transition: transform 2s ease;
}

.pane {
	flex: 1 1 0;
	min-width: 0;
	height: 100%;
}

.screen-ab .pane + .pane {
	border-left: 1px solid #fff;
}

.setup {
	position: fixed;
	inset: 0;
	display: grid;
	place-items: center;
	background: rgba(0, 0, 0, 0.85);
	cursor: default;
	z-index: 10;
}

.setup-box {
	max-width: 40rem;
	padding: 2rem;
	border: 1px solid #fff;
	line-height: 1.6;
}

.setup-box h2 {
	font-size: 0.75rem;
	font-weight: 500;
	text-transform: uppercase;
	letter-spacing: 0.2em;
	color: rgba(255, 255, 255, 0.6);
	margin: 1.2rem 0 0.4rem;
}

button.on {
	background: #fff;
	color: #000;
	border-color: #fff;
}

.corner {
	position: fixed;
	top: 12px;
	left: 12px;
	z-index: 11;
	cursor: pointer;
}

.setup-box h1 {
	font-size: 1rem;
	font-weight: 500;
	text-transform: uppercase;
	letter-spacing: 0.2em;
	margin: 0 0 1rem;
}

.buttons {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
	margin: 1rem 0;
}

button {
	font: inherit;
	text-transform: uppercase;
	letter-spacing: 0.1em;
	color: #fff;
	background: #000;
	border: 1px solid #fff;
	padding: 0.4em 1em;
	cursor: pointer;
}

button:hover {
	background: #222;
}

.error {
	color: #f66;
}

.hint {
	color: rgba(255, 255, 255, 0.6);
	font-size: 0.85rem;
}
</style>
