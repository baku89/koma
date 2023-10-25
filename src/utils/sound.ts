import {Howl} from 'howler'

export async function speak(text: string) {
	// https://mdn.github.io/dom-examples/web-speech-api/speak-easy-synthesis/script.js
	const synth = window.speechSynthesis

	if (!synth) {
		console.error('SpeechSynthesisUtterance not supported')
		return
	}

	const isAlphabeticalOnly = /^[a-zA-Z0-9\s]+$/.test(text)

	const voiceName = isAlphabeticalOnly ? 'Samantha' : '日本語'

	const voice = synth.getVoices().find(v => v.name.includes(voiceName))

	if (!voice) {
		console.error(`Voice "${voiceName}" not found`)
		return
	}

	const utterThis = new SpeechSynthesisUtterance(text)
	utterThis.voice = voice

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

export function seekAndPlay(sound: Howl, seconds: number): Promise<void> {
	return new Promise(resolve => {
		sound.once('play', () => resolve())
		sound.stop()
		sound.seek(seconds)
		sound.play()
	})
}

export function scrub(sound: Howl, seconds: number, durationMs: number) {
	sound.once('play', () => {
		setTimeout(() => sound.stop(), durationMs)
	})
	sound.seek(seconds)
	sound.play()
}
