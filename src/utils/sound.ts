import {Howl} from 'howler'

export async function speak(text: string) {
	// https://mdn.github.io/dom-examples/web-speech-api/speak-easy-synthesis/script.js
	const synth = window.speechSynthesis

	if (!synth) {
		// eslint-disable-next-line no-console
		console.error('SpeechSynthesisUtterance not supported')
		return
	}

	const isAlphabeticalOnly = /^[a-zA-Z0-9\s]+$/.test(text)

	const voiceName = isAlphabeticalOnly ? 'Samantha' : '日本語'

	const voice = synth.getVoices().find(v => v.name.includes(voiceName))

	if (!voice) {
		// eslint-disable-next-line no-console
		console.error(`Voice "${voiceName}" not found`)
		return
	}

	const utterThis = new SpeechSynthesisUtterance(text)
	utterThis.voice = voice
	utterThis.rate = 1.5

	return new Promise((resolve, reject) => {
		utterThis.onend = resolve
		utterThis.onerror = reject
		synth.speak(utterThis)
	})
}

export function playSound(src: string): Promise<void> {
	const sound = new Howl({
		src: [src],
		volume: 0.5,
	})
	return new Promise(resolve => {
		sound.once('end', () => resolve())
		sound.play()
	})
}

export function seekAndPlay(
	sound: Howl | null | undefined,
	seconds: number
): Promise<void> {
	if (!sound) return Promise.resolve()

	return new Promise(resolve => {
		sound.once('play', () => resolve())
		sound.stop()
		sound.seek(seconds)
		sound.play()
	})
}

export function scrub(
	sound: Howl | null | undefined,
	seconds: number,
	durationMs: number
) {
	if (!sound) return

	sound.once('play', () => {
		setTimeout(() => sound.stop(), durationMs)
	})
	sound.seek(seconds)
	sound.play()
}

let buzzerContext: AudioContext | null = null
const BUZZER_GAIN = 0.175

/**
 * A synthesized buzzer, loud and unlike the sampled UI sounds, for "come
 * back to the machine" moments: `done` is three short high beeps, `error`
 * two long low ones.
 */
export function buzz(kind: 'done' | 'error' = 'done') {
	try {
		buzzerContext ??= new AudioContext()
		const ctx = buzzerContext
		if (ctx.state === 'suspended') void ctx.resume()
		const [freq, on, gap, count] = kind === 'done' ? [1320, 0.16, 0.1, 3] : [196, 0.45, 0.15, 2]
		for (let i = 0; i < count; i++) {
			const t = ctx.currentTime + 0.02 + i * (on + gap)
			const osc = ctx.createOscillator()
			const gain = ctx.createGain()
			osc.type = 'square'
			osc.frequency.value = freq
			gain.gain.setValueAtTime(0, t)
			gain.gain.linearRampToValueAtTime(BUZZER_GAIN, t + 0.005)
			gain.gain.setValueAtTime(BUZZER_GAIN, t + on - 0.01)
			gain.gain.linearRampToValueAtTime(0, t + on)
			osc.connect(gain).connect(ctx.destination)
			osc.start(t)
			osc.stop(t + on + 0.01)
		}
	} catch {
		// No audio output: the buzzer is a convenience, never a failure.
	}
}
