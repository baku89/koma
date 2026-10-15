import {onMounted, onUnmounted, ref, watch} from 'vue'

/**
 * Ambient sound for screen A (ADDSUB.md §15): the click/percussion stem of
 * the Max Cooper track, looped from `public/sound/`. Plays whenever screen A
 * is visible (`?screen=a` or both). Kiosk Chrome is launched with
 * `--autoplay-policy=no-user-gesture-required`; elsewhere autoplay may be
 * blocked, so the first pointer/key gesture on the page starts it.
 * Volume and on/off live in localStorage (per exhibit machine, set from the
 * setup overlay). `?mute` in the URL keeps it silent regardless.
 *
 * `?displays=<n>` (the kiosk adds it: the number of displays the exhibit is
 * set up for) silences it while fewer displays than that are connected —
 * projectors switched off for the night, a cable pulled — and brings it back
 * with them. Needs the window-management permission (the kiosk grants it);
 * without it the displays are unknown and the sound stays on.
 */
export const SOUND_SRC = 'sound/exhibit-clicks.mp3'

const VOLUME_KEY = 'exhibit.sound.volume'
const ENABLED_KEY = 'exhibit.sound.enabled'

function readNumber(key: string, fallback: number) {
	try {
		const v = localStorage.getItem(key)
		const n = v === null ? NaN : Number(v)
		return Number.isFinite(n) ? n : fallback
	} catch {
		return fallback
	}
}

function readBool(key: string, fallback: boolean) {
	try {
		const v = localStorage.getItem(key)
		return v === null ? fallback : v === '1'
	} catch {
		return fallback
	}
}

function write(key: string, value: string) {
	try {
		localStorage.setItem(key, value)
	} catch {
		// private window / storage blocked: keep the in-memory value only
	}
}

interface ScreenDetails extends EventTarget {
	screens: unknown[]
}

export function useExhibitSound(active: boolean) {
	const params = new URLSearchParams(location.search)
	const muted = params.has('mute')
	const expectedDisplays = Math.max(0, Math.floor(Number(params.get('displays')) || 0))
	const enabled = ref(readBool(ENABLED_KEY, true))
	const volume = ref(Math.min(1, Math.max(0, readNumber(VOLUME_KEY, 1))))
	/** true while autoplay is blocked and we wait for a gesture */
	const blocked = ref(false)
	const playing = ref(false)
	/** true while a display the exhibit is set up for is not connected */
	const displaysOff = ref(false)

	let audio: HTMLAudioElement | null = null

	function shouldPlay() {
		return active && !muted && enabled.value && !displaysOff.value
	}

	async function tryPlay() {
		if (!audio || !shouldPlay()) return
		try {
			await audio.play()
			blocked.value = false
			playing.value = true
		} catch (e) {
			// NotAllowedError: autoplay policy. Wait for a gesture.
			blocked.value = (e as DOMException)?.name === 'NotAllowedError'
			playing.value = false
			if (blocked.value) armGesture()
		}
	}

	let armed = false
	function armGesture() {
		if (armed) return
		armed = true
		const onGesture = () => {
			disarm()
			void tryPlay()
		}
		const disarm = () => {
			armed = false
			window.removeEventListener('pointerdown', onGesture)
			window.removeEventListener('keydown', onGesture)
		}
		window.addEventListener('pointerdown', onGesture)
		window.addEventListener('keydown', onGesture)
	}

	function sync() {
		if (!audio) return
		audio.volume = volume.value
		if (shouldPlay()) {
			if (audio.paused) void tryPlay()
		} else if (!audio.paused) {
			audio.pause()
			playing.value = false
		}
	}

	watch(volume, v => {
		write(VOLUME_KEY, String(v))
		if (audio) audio.volume = v
	})
	watch(enabled, v => {
		write(ENABLED_KEY, v ? '1' : '0')
		sync()
	})
	watch(displaysOff, sync)

	let screenDetails: ScreenDetails | null = null
	let unmounted = false
	function updateDisplays() {
		if (screenDetails) displaysOff.value = screenDetails.screens.length < expectedDisplays
	}
	async function watchDisplays() {
		const getScreenDetails = (window as any).getScreenDetails as
			| (() => Promise<ScreenDetails>)
			| undefined
		if (!expectedDisplays || typeof getScreenDetails !== 'function') return
		try {
			const permission = await navigator.permissions.query({
				name: 'window-management' as PermissionName,
			})
			// Only once it is granted: asking would put a prompt on the screen.
			const start = async () => {
				if (permission.state !== 'granted' || screenDetails || unmounted) return
				const details = await getScreenDetails.call(window)
				if (screenDetails || unmounted) return
				screenDetails = details
				details.addEventListener('screenschange', updateDisplays)
				updateDisplays()
			}
			permission.addEventListener('change', () => void start().catch(() => {}))
			await start()
		} catch {
			// displays unknown: the sound stays on
		}
	}

	onMounted(() => {
		if (!active || muted) return
		audio = new Audio(SOUND_SRC)
		audio.loop = true
		audio.preload = 'auto'
		audio.volume = volume.value
		// The displays first: no burst of sound on a load with one missing.
		void watchDisplays().finally(sync)
	})

	onUnmounted(() => {
		unmounted = true
		screenDetails?.removeEventListener('screenschange', updateDisplays)
		audio?.pause()
		audio = null
	})

	return {enabled, volume, blocked, playing, displaysOff, muted, active}
}
