import {Howl} from 'howler'

import {detectLanguage} from './language'

/**
 * Voices that macOS ships for fun (robots, singing, cartoon relatives). They
 * match a language's `lang` like any other voice but are not what an
 * operator wants to hear a warning in.
 */
const NOVELTY_VOICE =
	/^(Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley|Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Junior|Kathy|Ralph)\b/

async function getVoices(): Promise<SpeechSynthesisVoice[]> {
	const synth = window.speechSynthesis
	const voices = synth.getVoices()
	if (voices.length > 0) return voices

	// Chrome fills the list asynchronously on first use.
	return new Promise(resolve => {
		const done = () => {
			synth.removeEventListener('voiceschanged', done)
			resolve(synth.getVoices())
		}
		synth.addEventListener('voiceschanged', done)
		setTimeout(done, 1000)
	})
}

function pickVoice(voices: SpeechSynthesisVoice[], lang: string) {
	const candidates = voices.filter(
		v => v.lang.toLowerCase().replace('_', '-').split('-')[0] === lang
	)
	const rank = (v: SpeechSynthesisVoice) =>
		(NOVELTY_VOICE.test(v.name) ? 4 : 0) +
		(v.localService ? 0 : 2) +
		(v.default ? 0 : 1)
	return candidates.sort((a, b) => rank(a) - rank(b))[0] ?? null
}

/**
 * Reads `text` aloud in the language it appears to be written in (by the
 * script of its letters, see `detectLanguage`), with a voice chosen by
 * language rather than by name so any installed language works.
 */
export async function speak(text: string) {
	const synth = window.speechSynthesis

	if (!synth) {
		// eslint-disable-next-line no-console
		console.error('SpeechSynthesisUtterance not supported')
		return
	}

	// Kanji-only text is read as Japanese on a Japanese machine.
	const han = navigator.language.toLowerCase().startsWith('ja') ? 'ja' : 'zh'
	const lang = detectLanguage(text, {han})
	const voice = pickVoice(await getVoices(), lang)

	const utterThis = new SpeechSynthesisUtterance(text)
	// With no matching voice the browser picks one for `lang` itself.
	utterThis.lang = voice?.lang ?? lang
	if (voice) utterThis.voice = voice
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
