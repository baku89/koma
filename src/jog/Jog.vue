<script setup lang="ts">
/**
 * Phone jog pendant (`/jog.html`): step-jog the FluidNC machines from a
 * phone through koma-relay (see stores/remoteJog.ts for the koma end).
 *
 * The page knows nothing about serial ports: it shows the `machine:<id>`
 * state topics the shooting machine publishes and sends `jog` control
 * messages. Every tap is one step (no press-and-hold — a lost "release"
 * over Wi-Fi must never leave an axis running).
 *
 * URL: `?machine=mill|rig` picks the tab, `?relay=http://host:port` the relay
 * (default: the page's own origin, i.e. when served by koma-relay),
 * `?token=…` the relay token; the last two are remembered on the phone.
 *
 * Axis colours match koma's 3D view (X red, Y green, Z blue, A/B/C
 * orange/magenta/cyan). The pads are laid out per machine so the arrows
 * point where the machine actually moves: the mill in its own Z-up frame
 * (with the F/B/L/R side each direction faces, ADDSUB.md §3.0), the Box Rig
 * in the Y-up world frame seen from above with the F side at the bottom.
 */
import {computed, onMounted, ref, watch} from 'vue'

import {useJogRelay} from './relay'

type Axis = 'x' | 'y' | 'z' | 'a' | 'b' | 'c'

interface MachineTopic {
	connected: boolean
	state: string | null
	mpos: Partial<Record<Axis, number>>
	wpos: Partial<Record<Axis, number>>
	alarm: {code: number; message: string} | null
	busy: boolean
	/** Grbl `Ov:` feed / rapid / spindle overrides in %, once reported. */
	override?: {feed: number; rapid: number; spindle: number} | null
	def?: {
		id: string
		label: string
		axes: Axis[]
		units: Partial<Record<Axis, 'mm' | 'deg'>>
		jogFeed: number
		/** False = no feed override row (the rig); koma jogs at its own default feed. */
		showFeed?: boolean
	}
	t: number
}

interface PadButton {
	axis: Axis
	sign: 1 | -1
	/** Where this direction goes, in words the operator uses. */
	hint: string
	glyph: string
}

interface Cross {
	kind: 'cross'
	title: string
	up: PadButton
	down: PadButton
	left: PadButton
	right: PadButton
	/** The third (vertical) axis, tucked into the top-right / bottom-right corners. */
	cornerUp?: PadButton
	cornerDown?: PadButton
}

interface Column {
	kind: 'column'
	title: string
	up: PadButton
	down: PadButton
}

interface Pair {
	kind: 'pair'
	title: string
	minus: PadButton
	plus: PadButton
}

type PadGroup = Cross | Column | Pair

const AXIS_COLOR: Record<Axis, string> = {
	x: '#ff5555',
	y: '#55ff55',
	z: '#5588ff',
	a: '#ffaa33',
	b: '#ff66ff',
	c: '#66ffff',
}

const AXIS_NAME: Record<Axis, string> = {
	x: 'X',
	y: 'Y',
	z: 'Z',
	a: 'A · tilt',
	b: 'B · pan',
	c: 'C · roll',
}

/** Per-machine pad layouts (koma's addsub machines); anything else is generic. */
const LAYOUTS: Record<string, PadGroup[]> = {
	mill: [
		{
			kind: 'cross',
			title: 'X / Y (table, from the front) · Z (spindle) in the corners',
			up: {axis: 'y', sign: 1, hint: 'back · R side', glyph: '▲'},
			down: {axis: 'y', sign: -1, hint: 'front · L side', glyph: '▼'},
			left: {axis: 'x', sign: -1, hint: 'left · B side', glyph: '◀'},
			right: {axis: 'x', sign: 1, hint: 'right · F side', glyph: '▶'},
			cornerUp: {axis: 'z', sign: 1, hint: 'spindle up', glyph: '▲'},
			cornerDown: {axis: 'z', sign: -1, hint: 'spindle down', glyph: '▼'},
		},
	],
	rig: [
		{
			kind: 'cross',
			title: 'X / Z (top view, F side at the bottom) · Y (height) in the corners',
			up: {axis: 'z', sign: -1, hint: 'B side · away', glyph: '▲'},
			down: {axis: 'z', sign: 1, hint: 'F side · toward you', glyph: '▼'},
			left: {axis: 'x', sign: -1, hint: 'L side', glyph: '◀'},
			right: {axis: 'x', sign: 1, hint: 'R side', glyph: '▶'},
			cornerUp: {axis: 'y', sign: 1, hint: 'camera up', glyph: '▲'},
			cornerDown: {axis: 'y', sign: -1, hint: 'camera down', glyph: '▼'},
		},
		{
			// Seen through the camera: +pan (about world +Y) turns the view left,
			// +tilt (about +X) raises it; +roll (about +Z, the camera looking
			// down −Z) appears clockwise. Signs on the real head are to be
			// verified (ADDSUB.md §10) — swap the `sign`s here if an arrow is
			// backwards, nothing else depends on them.
			kind: 'cross',
			title: 'Tilt / Pan (camera view) · Roll in the corners',
			up: {axis: 'a', sign: 1, hint: 'tilt up', glyph: '▲'},
			down: {axis: 'a', sign: -1, hint: 'tilt down', glyph: '▼'},
			left: {axis: 'b', sign: 1, hint: 'pan left', glyph: '◀'},
			right: {axis: 'b', sign: -1, hint: 'pan right', glyph: '▶'},
			cornerUp: {axis: 'c', sign: 1, hint: 'roll clockwise', glyph: '↻'},
			cornerDown: {axis: 'c', sign: -1, hint: 'roll counter-clockwise', glyph: '↺'},
		},
	],
}

function genericLayout(axes: Axis[]): PadGroup[] {
	return axes.map(axis => ({
		kind: 'pair',
		title: AXIS_NAME[axis] ?? axis.toUpperCase(),
		minus: {axis, sign: -1, hint: `${axis.toUpperCase()}−`, glyph: '−'},
		plus: {axis, sign: 1, hint: `${axis.toUpperCase()}+`, glyph: '+'},
	}))
}

const LINEAR_STEPS = [0.1, 1, 10, 50]
const ROTARY_STEPS = [0.1, 1, 5, 15]
/** Feed override steps (Grbl real-time 0x90–0x94, as cncjs' slider sends them). */
const FEED_OVERRIDE_STEPS: {label: string; value: 0 | 10 | -10 | 1 | -1}[] = [
	{label: '−10', value: -10},
	{label: '−1', value: -1},
	{label: '100%', value: 0},
	{label: '+1', value: 1},
	{label: '+10', value: 10},
]
const RAPID_OVERRIDES: (25 | 50 | 100)[] = [25, 50, 100]

//------------------------------------------------------------------------------
// Connection

const relay = useJogRelay()
const params = new URLSearchParams(location.search)

function remembered(key: string, fallback: string) {
	try {
		return localStorage.getItem(key) ?? fallback
	} catch {
		return fallback
	}
}

function remember(key: string, value: string) {
	try {
		localStorage.setItem(key, value)
	} catch {
		// private mode etc.
	}
}

const relayUrl = ref(params.get('relay') ?? remembered('jog.relay', location.origin))
const token = ref(params.get('token') ?? remembered('jog.token', ''))
const showSettings = ref(false)

function applySettings() {
	remember('jog.relay', relayUrl.value)
	remember('jog.token', token.value)
	relay.connect(relayUrl.value, token.value)
	showSettings.value = false
}

//------------------------------------------------------------------------------
// Machines

const machineIds = computed<string[]>(() => {
	const listed = relay.topics.remoteJog?.data?.machines
	if (Array.isArray(listed) && listed.length) return listed
	return Object.keys(relay.topics)
		.filter(k => k.startsWith('machine:'))
		.map(k => k.slice('machine:'.length))
})

const selected = ref(params.get('machine') ?? '')
watch(
	machineIds,
	ids => {
		// Keep the URL's choice until the machines are known.
		if (ids.length && !ids.includes(selected.value)) selected.value = ids[0]
	},
	{immediate: true}
)

const machine = computed<MachineTopic | null>(() => relay.topics[`machine:${selected.value}`]?.data ?? null)
const def = computed(() => machine.value?.def ?? null)
const axes = computed<Axis[]>(() => def.value?.axes ?? [])
const layout = computed<PadGroup[]>(() => {
	const groups = LAYOUTS[selected.value] ?? genericLayout(axes.value)
	// Only pads for axes this machine actually reports.
	return groups.filter(g =>
		(g.kind === 'cross'
			? [g.up, g.down, g.left, g.right, ...(g.cornerUp ? [g.cornerUp] : []), ...(g.cornerDown ? [g.cornerDown] : [])]
			: g.kind === 'column'
				? [g.up, g.down]
				: [g.minus, g.plus]
		).every(b => axes.value.includes(b.axis))
	)
})

function labelOf(id: string) {
	return relay.topics[`machine:${id}`]?.data?.def?.label ?? id
}

const remoteEnabled = computed(() => relay.topics.remoteJog?.data?.enabled !== false)

const canMove = computed(
	() =>
		relay.connected.value &&
		relay.captureOnline.value &&
		remoteEnabled.value &&
		!!machine.value?.connected &&
		machine.value.state !== 'Alarm' &&
		!machine.value.busy
)

const stateClass = computed(() => {
	const s = machine.value?.state
	if (!machine.value?.connected) return 'off'
	if (s === 'Alarm') return 'alarm'
	if (s === 'Hold' || s === 'Door') return 'hold'
	if (s === 'Run' || s === 'Jog' || s === 'Home') return 'busy'
	return 'idle'
})

const statusText = computed(() => {
	if (relay.rejected.value) return 'relay refused the connection — check the token'
	if (!relay.connected.value) return `connecting to ${relay.base.value ?? relayUrl.value}…`
	if (!relay.captureOnline.value) return 'koma (shooting machine) is offline'
	if (!remoteEnabled.value) return 'remote jog is disabled in koma'
	if (!machine.value) return 'no machine reported yet'
	if (!machine.value.connected) return `${def.value?.label ?? selected.value} is not connected to koma`
	if (machine.value.alarm) return `ALARM:${machine.value.alarm.code} ${machine.value.alarm.message}`
	if (machine.value.busy) return 'busy (a sequence or homing is running)'
	return machine.value.state ?? '…'
})

//------------------------------------------------------------------------------
// Steps and feed

const linearStep = ref(1)
const rotaryStep = ref(1)

function unitOf(axis: Axis): 'mm' | 'deg' {
	return def.value?.units?.[axis] ?? 'mm'
}

function stepFor(axis: Axis) {
	return unitOf(axis) === 'deg' ? rotaryStep.value : linearStep.value
}

const hasRotary = computed(() => axes.value.some(a => unitOf(a) === 'deg'))
/** Whether this machine gets the feed / rapid override row (the mill). */
const showOverride = computed(() => def.value?.showFeed !== false)
const feedPercent = computed(() => machine.value?.override?.feed ?? null)
const rapidPercent = computed(() => machine.value?.override?.rapid ?? null)

// Overrides act on whatever the controller is doing right now (a running
// G-code program included), so they only need the machine to be connected.
const canOverride = computed(
	() =>
		relay.connected.value &&
		relay.captureOnline.value &&
		remoteEnabled.value &&
		!!machine.value?.connected
)

function feedOverride(value: 0 | 10 | -10 | 1 | -1) {
	if (!canOverride.value) {
		showToast(statusText.value, true)
		return
	}
	sendAction('feedOverride', {value})
}

function rapidOverride(value: 25 | 50 | 100) {
	if (!canOverride.value) {
		showToast(statusText.value, true)
		return
	}
	sendAction('rapidOverride', {value})
}

//------------------------------------------------------------------------------
// Sending

let nextId = 1
const pending = new Map<number, {action: string; axis?: Axis}>()
const toast = ref<{text: string; error: boolean} | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null

function showToast(text: string, error = false) {
	toast.value = {text, error}
	if (toastTimer) clearTimeout(toastTimer)
	toastTimer = setTimeout(() => (toast.value = null), error ? 5000 : 1500)
}

function buzz(ms = 12) {
	try {
		navigator.vibrate?.(ms)
	} catch {
		// not supported
	}
}

function sendAction(action: string, extra: Record<string, unknown> = {}) {
	if (!relay.connected.value) {
		showToast('Not connected to the relay', true)
		return
	}
	const id = nextId++
	pending.set(id, {action, axis: extra.axis as Axis | undefined})
	relay.control('jog', {id, machine: selected.value, action, ...extra})
	buzz()
}

function step(b: PadButton) {
	if (!canMove.value) {
		showToast(statusText.value, true)
		buzz(40)
		return
	}
	const delta = b.sign * stepFor(b.axis)
	sendAction('step', {axis: b.axis, delta})
}

// Result of each message: only errors need a word; a successful step is
// visible in the position readout.
watch(
	() => relay.topics['jog:result'],
	entry => {
		const r = entry?.data
		if (!r || typeof r.id !== 'number') return
		const p = pending.get(r.id)
		if (!p) return
		pending.delete(r.id)
		if (!r.ok) {
			showToast(r.error ?? `${p.action} failed`, true)
			buzz(60)
		} else if (p.action !== 'step') {
			showToast(`${p.action} ok`)
		}
	}
)

// Two-tap confirmation for the things that move a lot or forget state.
const armed = ref<string | null>(null)
let armTimer: ReturnType<typeof setTimeout> | null = null

function confirmThen(action: string) {
	if (armed.value === action) {
		armed.value = null
		if (armTimer) clearTimeout(armTimer)
		sendAction(action)
		return
	}
	armed.value = action
	buzz(20)
	if (armTimer) clearTimeout(armTimer)
	armTimer = setTimeout(() => (armed.value = null), 3000)
}

function estop() {
	sendAction('estop')
	buzz(200)
}

//------------------------------------------------------------------------------
// Display helpers

function fmt(v: number | undefined, axis: Axis) {
	if (v === undefined || !Number.isFinite(v)) return '—'
	return v.toFixed(unitOf(axis) === 'deg' ? 2 : 3)
}

function padStyle(axis: Axis) {
	return {'--axis': AXIS_COLOR[axis]}
}

//------------------------------------------------------------------------------
// Lifecycle

let wakeLock: any = null

async function keepAwake() {
	if (wakeLock) return
	try {
		wakeLock = await (navigator as any).wakeLock?.request('screen')
		wakeLock?.addEventListener('release', () => (wakeLock = null))
	} catch {
		// not granted / not supported
	}
}

onMounted(() => {
	relay.connect(relayUrl.value, token.value)
	if (params.has('relay')) remember('jog.relay', relayUrl.value)
	if (params.has('token')) remember('jog.token', token.value)
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') void keepAwake()
	})
})
</script>

<template>
	<div class="jog" @pointerdown.once="keepAwake">
		<header>
			<button class="estop" @click="estop">
				<span class="octagon">■</span> ESTOP
			</button>
			<div class="conn">
				<span class="dot" :class="{on: relay.connected.value}" title="relay" />
				<span class="dot" :class="{on: relay.captureOnline.value}" title="koma" />
				<button class="gear" @click="showSettings = !showSettings">⚙</button>
			</div>
		</header>

		<form v-if="showSettings" class="settings" @submit.prevent="applySettings">
			<label>
				Relay
				<input v-model="relayUrl" type="url" inputmode="url" placeholder="http://koma-exhibit.local:7777" />
			</label>
			<label>
				Token
				<input v-model="token" type="text" autocomplete="off" placeholder="(none)" />
			</label>
			<button type="submit">Connect</button>
		</form>

		<nav class="tabs">
			<button
				v-for="id in machineIds"
				:key="id"
				:class="{active: id === selected}"
				@click="selected = id"
			>
				{{ labelOf(id) }}
			</button>
			<span v-if="!machineIds.length" class="muted">no machines yet</span>
		</nav>

		<div class="status" :class="stateClass">{{ statusText }}</div>

		<table v-if="machine" class="pos">
			<thead>
				<tr>
					<th></th>
					<th>machine</th>
					<th>work</th>
				</tr>
			</thead>
			<tbody>
				<tr v-for="a in axes" :key="a" :style="padStyle(a)">
					<th class="axis">{{ a.toUpperCase() }}</th>
					<td>{{ fmt(machine.mpos?.[a], a) }}</td>
					<td>{{ fmt(machine.wpos?.[a], a) }}</td>
				</tr>
			</tbody>
		</table>

		<section class="chips">
			<div class="chip-row">
				<span class="chip-label">step mm</span>
				<button
					v-for="s in LINEAR_STEPS"
					:key="s"
					:class="{active: linearStep === s}"
					@click="linearStep = s"
				>
					{{ s }}
				</button>
			</div>
			<div v-if="hasRotary" class="chip-row">
				<span class="chip-label">step °</span>
				<button
					v-for="s in ROTARY_STEPS"
					:key="s"
					:class="{active: rotaryStep === s}"
					@click="rotaryStep = s"
				>
					{{ s }}
				</button>
			</div>
			<template v-if="showOverride">
				<div class="chip-row override">
					<span class="chip-label">feed ovr</span>
					<button
						v-for="o in FEED_OVERRIDE_STEPS"
						:key="o.value"
						:class="{reset: o.value === 0}"
						:disabled="!canOverride"
						@click="feedOverride(o.value)"
					>
						{{ o.label }}
					</button>
					<span class="ovr-value" :class="{changed: feedPercent !== null && feedPercent !== 100}">
						{{ feedPercent === null ? '—' : `${feedPercent}%` }}
					</span>
				</div>
				<div class="chip-row override">
					<span class="chip-label">rapid ovr</span>
					<button
						v-for="r in RAPID_OVERRIDES"
						:key="r"
						:class="{active: rapidPercent === r}"
						:disabled="!canOverride"
						@click="rapidOverride(r)"
					>
						{{ r }}%
					</button>
				</div>
			</template>
		</section>

		<section class="pads" :class="{disabled: !canMove}">
			<template v-for="(g, i) in layout" :key="i">
				<div v-if="g.kind === 'cross'" class="group cross">
					<div class="title">{{ g.title }}</div>
					<div class="grid3">
						<button class="pad up" :style="padStyle(g.up.axis)" :title="g.up.hint" @click="step(g.up)">
							<span class="glyph">{{ g.up.glyph }}</span>
							<span class="name">{{ g.up.axis.toUpperCase() }}{{ g.up.sign > 0 ? '+' : '−' }}</span>
						</button>
						<button class="pad left" :style="padStyle(g.left.axis)" :title="g.left.hint" @click="step(g.left)">
							<span class="glyph">{{ g.left.glyph }}</span>
							<span class="name">{{ g.left.axis.toUpperCase() }}{{ g.left.sign > 0 ? '+' : '−' }}</span>
						</button>
						<div class="center">
							<span :style="padStyle(g.right.axis)" class="axis-tag">{{ g.right.axis.toUpperCase() }}</span>
							<span :style="padStyle(g.up.axis)" class="axis-tag">{{ g.up.axis.toUpperCase() }}</span>
						</div>
						<button class="pad right" :style="padStyle(g.right.axis)" :title="g.right.hint" @click="step(g.right)">
							<span class="glyph">{{ g.right.glyph }}</span>
							<span class="name">{{ g.right.axis.toUpperCase() }}{{ g.right.sign > 0 ? '+' : '−' }}</span>
						</button>
						<button class="pad down" :style="padStyle(g.down.axis)" :title="g.down.hint" @click="step(g.down)">
							<span class="glyph">{{ g.down.glyph }}</span>
							<span class="name">{{ g.down.axis.toUpperCase() }}{{ g.down.sign > 0 ? '+' : '−' }}</span>
						</button>
						<button
							v-if="g.cornerUp"
							class="pad corner-up"
							:style="padStyle(g.cornerUp.axis)"
							:title="g.cornerUp.hint" @click="step(g.cornerUp)"
						>
							<span class="glyph">{{ g.cornerUp.glyph }}</span>
							<span class="name">{{ g.cornerUp.axis.toUpperCase() }}{{ g.cornerUp.sign > 0 ? '+' : '−' }}</span>
						</button>
						<button
							v-if="g.cornerDown"
							class="pad corner-down"
							:style="padStyle(g.cornerDown.axis)"
							:title="g.cornerDown.hint" @click="step(g.cornerDown)"
						>
							<span class="glyph">{{ g.cornerDown.glyph }}</span>
							<span class="name">{{ g.cornerDown.axis.toUpperCase() }}{{ g.cornerDown.sign > 0 ? '+' : '−' }}</span>
						</button>
					</div>
				</div>
				<div v-else-if="g.kind === 'column'" class="group column">
					<div class="title">{{ g.title }}</div>
					<div class="stack">
						<button class="pad" :style="padStyle(g.up.axis)" :title="g.up.hint" @click="step(g.up)">
							<span class="glyph">{{ g.up.glyph }}</span>
							<span class="name">{{ g.up.axis.toUpperCase() }}{{ g.up.sign > 0 ? '+' : '−' }}</span>
						</button>
						<button class="pad" :style="padStyle(g.down.axis)" :title="g.down.hint" @click="step(g.down)">
							<span class="glyph">{{ g.down.glyph }}</span>
							<span class="name">{{ g.down.axis.toUpperCase() }}{{ g.down.sign > 0 ? '+' : '−' }}</span>
						</button>
					</div>
				</div>
				<div v-else class="group pair">
					<div class="title">{{ g.title }}</div>
					<div class="row">
						<button class="pad" :style="padStyle(g.minus.axis)" :title="g.minus.hint" @click="step(g.minus)">
							<span class="glyph">{{ g.minus.glyph }}</span>
							<span class="name">{{ g.minus.hint }}</span>
						</button>
						<button class="pad" :style="padStyle(g.plus.axis)" :title="g.plus.hint" @click="step(g.plus)">
							<span class="glyph">{{ g.plus.glyph }}</span>
							<span class="name">{{ g.plus.hint }}</span>
						</button>
					</div>
				</div>
			</template>
		</section>

		<section class="actions">
			<button class="stop" @click="sendAction('cancel')">STOP JOG</button>
			<button @click="sendAction('hold')">Hold</button>
			<button @click="sendAction('resume')">Resume</button>
			<button @click="sendAction('unlock')">Unlock</button>
			<button :class="{armed: armed === 'home'}" @click="confirmThen('home')">
				{{ armed === 'home' ? 'Home?' : 'Home' }}
			</button>
			<button :class="{armed: armed === 'reset'}" @click="confirmThen('reset')">
				{{ armed === 'reset' ? 'Reset?' : 'Reset' }}
			</button>
			<button :class="{armed: armed === 'zero'}" @click="confirmThen('zero')">
				{{ armed === 'zero' ? 'Zero work here?' : 'Zero work' }}
			</button>
		</section>

		<transition name="fade">
			<div v-if="toast" class="toast" :class="{error: toast.error}">{{ toast.text }}</div>
		</transition>
	</div>
</template>

<style>
:root {
	color-scheme: dark;
}

html,
body {
	margin: 0;
	background: #000;
	color: #eee;
	font-family: Inter, system-ui, -apple-system, sans-serif;
	-webkit-text-size-adjust: 100%;
	overscroll-behavior: none;
}

button {
	font: inherit;
	color: inherit;
	touch-action: manipulation;
	-webkit-tap-highlight-color: transparent;
	user-select: none;
	-webkit-user-select: none;
}
</style>

<style scoped>
.jog {
	max-width: 32rem;
	margin: 0 auto;
	padding: calc(env(safe-area-inset-top) + 0.5rem) calc(env(safe-area-inset-right) + 0.75rem)
		calc(env(safe-area-inset-bottom) + 1rem) calc(env(safe-area-inset-left) + 0.75rem);
	display: flex;
	flex-direction: column;
	gap: 0.6rem;
	--mono: ui-monospace, 'SF Mono', Menlo, monospace;
}

header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 0.5rem;
}

.estop {
	flex: 1;
	height: 3.6rem;
	background: #c62828;
	border: 2px solid #ff5252;
	border-radius: 0.6rem;
	color: #fff;
	font-weight: 800;
	font-size: 1.2rem;
	letter-spacing: 0.1em;
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 0.5rem;
}

.estop:active {
	background: #8e0000;
}

.octagon {
	font-size: 1.3em;
	line-height: 1;
}

.conn {
	display: flex;
	align-items: center;
	gap: 0.5rem;
}

.dot {
	width: 0.7rem;
	height: 0.7rem;
	border-radius: 50%;
	background: #444;
}

.dot.on {
	background: #4caf50;
	box-shadow: 0 0 6px #4caf50;
}

.gear {
	background: none;
	border: 1px solid #333;
	border-radius: 0.4rem;
	width: 2.4rem;
	height: 2.4rem;
	font-size: 1.2rem;
}

.settings {
	display: flex;
	flex-direction: column;
	gap: 0.4rem;
	padding: 0.6rem;
	border: 1px solid #333;
	border-radius: 0.6rem;
}

.settings label {
	display: flex;
	flex-direction: column;
	gap: 0.2rem;
	font-size: 0.8rem;
	color: #aaa;
}

.settings input {
	font: inherit;
	font-family: var(--mono);
	padding: 0.5rem;
	border-radius: 0.4rem;
	border: 1px solid #444;
	background: #111;
	color: #eee;
}

.settings button {
	height: 2.6rem;
	border-radius: 0.4rem;
	border: 1px solid #555;
	background: #222;
}

.tabs {
	display: flex;
	gap: 0.4rem;
}

.tabs button {
	flex: 1;
	height: 2.8rem;
	border-radius: 0.5rem;
	border: 1px solid #444;
	background: #111;
	font-weight: 600;
}

.tabs button.active {
	background: #eee;
	color: #000;
	border-color: #eee;
}

.status {
	font-family: var(--mono);
	font-size: 0.85rem;
	padding: 0.4rem 0.6rem;
	border-radius: 0.4rem;
	background: #151515;
	color: #bbb;
	overflow-wrap: anywhere;
}

.status.idle {
	color: #8f8;
}

.status.busy {
	color: #8cf;
}

.status.hold {
	color: orange;
}

.status.alarm {
	color: #ff6b6b;
	background: #2a0f0f;
}

.pos {
	width: 100%;
	border-collapse: collapse;
	font-family: var(--mono);
	font-size: 1rem;
}

.pos th {
	font-weight: 400;
	color: #888;
	font-size: 0.75rem;
	text-align: right;
}

.pos td {
	text-align: right;
	padding: 0.1rem 0.4rem;
	font-variant-numeric: tabular-nums;
}

.pos .axis {
	text-align: left;
	color: var(--axis);
	font-weight: 700;
	font-size: 1rem;
}

.chips {
	display: flex;
	flex-direction: column;
	gap: 0.3rem;
}

.chip-row {
	display: flex;
	align-items: center;
	gap: 0.3rem;
}

.chip-label {
	width: 4.2rem;
	font-size: 0.75rem;
	color: #888;
}

.chip-row button {
	min-width: 3rem;
	height: 2.2rem;
	padding: 0 0.6rem;
	border-radius: 999px;
	border: 1px solid #444;
	background: #111;
	font-family: var(--mono);
}

.chip-row button.active {
	background: #eee;
	color: #000;
	border-color: #eee;
}

.chip-row.override button {
	min-width: 2.6rem;
	padding: 0 0.45rem;
}

.chip-row.override button.reset {
	border-color: #888;
}

.chip-row.override button:disabled {
	opacity: 0.4;
}

.ovr-value {
	margin-left: auto;
	font-family: var(--mono);
	font-size: 1rem;
	font-variant-numeric: tabular-nums;
}

.ovr-value.changed {
	color: orange;
	font-weight: 700;
}

.muted {
	color: #777;
	font-size: 0.8rem;
	font-family: var(--mono);
	margin-left: auto;
}

.pads {
	display: flex;
	flex-direction: column;
	gap: 0.5rem;
}

.pads.disabled .pad {
	opacity: 0.35;
}

.group .title {
	font-size: 0.75rem;
	color: #888;
	margin-bottom: 0.3rem;
}

.pad {
	background: color-mix(in srgb, var(--axis) 18%, #000);
	border: 2px solid var(--axis);
	border-radius: 0.8rem;
	color: var(--axis);
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 0.1rem;
	min-height: 3.2rem;
	padding: 0.25rem;
}

.pad:active {
	background: var(--axis);
	color: #000;
}

.pad .glyph {
	font-size: 1.25rem;
	line-height: 1;
}

.pad .name {
	font-family: var(--mono);
	font-weight: 700;
	font-size: 0.85rem;
}

.grid3 {
	display: grid;
	grid-template-columns: 1fr 1fr 1fr;
	grid-template-rows: 1fr 1fr 1fr;
	gap: 0.3rem;
	grid-template-areas:
		'. up corner-up'
		'left center right'
		'. down corner-down';
}

.grid3 .corner-up {
	grid-area: corner-up;
}

.grid3 .corner-down {
	grid-area: corner-down;
}

.grid3 .up {
	grid-area: up;
}

.grid3 .down {
	grid-area: down;
}

.grid3 .left {
	grid-area: left;
}

.grid3 .right {
	grid-area: right;
}

.grid3 .center {
	grid-area: center;
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 0.4rem;
	font-family: var(--mono);
	font-size: 0.8rem;
}

.axis-tag {
	color: var(--axis);
	border: 1px solid var(--axis);
	border-radius: 0.3rem;
	padding: 0.1rem 0.35rem;
	font-weight: 700;
}

.stack {
	display: grid;
	grid-template-columns: 1fr;
	gap: 0.4rem;
	max-width: 12rem;
}

.row {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 0.4rem;
}

.column,
.pair {
	flex: 1;
}

/* Wide phones / landscape: two crosses (rig: XYZ and tilt/pan/roll) side by side. */
@media (min-width: 30rem) {
	.pads {
		display: grid;
		grid-template-columns: 1fr 1fr;
		align-items: start;
	}

	.pads .group:only-child,
	.pads .column {
		grid-column: 1 / -1;
	}

	.stack {
		max-width: none;
	}
}

.actions {
	display: grid;
	grid-template-columns: repeat(4, 1fr);
	gap: 0.4rem;
}

.actions button {
	height: 2.8rem;
	border-radius: 0.5rem;
	border: 1px solid #555;
	background: #1a1a1a;
	font-size: 0.85rem;
}

.actions button:active {
	background: #333;
}

.actions .stop {
	grid-column: span 4;
	height: 3.4rem;
	font-weight: 800;
	letter-spacing: 0.08em;
	border-color: orange;
	color: orange;
}

.actions .armed {
	background: #eee;
	color: #000;
}

.toast {
	position: fixed;
	left: 50%;
	bottom: calc(env(safe-area-inset-bottom) + 1rem);
	transform: translateX(-50%);
	max-width: 90vw;
	padding: 0.6rem 1rem;
	border-radius: 0.6rem;
	background: #2e7d32;
	color: #fff;
	font-family: var(--mono);
	font-size: 0.85rem;
	box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
}

.toast.error {
	background: #b71c1c;
}

.fade-enter-active,
.fade-leave-active {
	transition: opacity 0.15s;
}

.fade-enter-from,
.fade-leave-to {
	opacity: 0;
}
</style>
