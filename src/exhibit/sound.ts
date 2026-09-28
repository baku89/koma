import {onMounted, onUnmounted, ref, watch} from 'vue'

/**
 * Ambient sound for screen A (ADDSUB.md §15): the click/percussion stem of
 * the Max Cooper track, looped from `public/sound/`. Plays whenever screen A
 * is visible (`?screen=a` or both). Kiosk Chrome is launched with
 * `--autoplay-policy=no-user-gesture-required`; elsewhere autoplay may be
 * blocked, so the first pointer/key gesture on the page starts it.
 * Volume and on/off live in localStorage (per exhibit machine, set from the
 * setup overlay). `?mute` in the URL keeps it silent regardless.
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

export function useExhibitSound(active: boolean) {
	const muted = new URLSearchParams(location.search).has('mute')
	const enabled = ref(readBool(ENABLED_KEY, true))
	const volume = ref(Math.min(1, Math.max(0, readNumber(VOLUME_KEY, 1))))
	/** true while autoplay is blocked and we wait for a gesture */
	const blocked = ref(false)
	const playing = ref(false)

	let audio: HTMLAudioElement | null = null

	function shouldPlay() {
		return active && !muted && enabled.value
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

	onMounted(() => {
		if (!active || muted) return
		audio = new Audio(SOUND_SRC)
		audio.loop = true
		audio.preload = 'auto'
		audio.volume = volume.value
		sync()
	})

	onUnmounted(() => {
		audio?.pause()
		audio = null
	})

	return {enabled, volume, blocked, playing, muted, active}
}
