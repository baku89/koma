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
