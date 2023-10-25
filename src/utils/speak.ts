export async function speak(text: string) {
	// https://mdn.github.io/dom-examples/web-speech-api/speak-easy-synthesis/script.js
	const synth = window.speechSynthesis

	if (!synth) {
		console.error('SpeechSynthesisUtterance not supported')
		return
	}

	const voice = synth.getVoices().find(v => v.name === 'Google 日本語')

	if (!voice) {
		console.error(`Voice "${voice}" not found`)
		return
	}

	const utterThis = new SpeechSynthesisUtterance(text)
	utterThis.voice = voice
	utterThis.rate = 0.5

	return new Promise((resolve, reject) => {
		utterThis.onend = resolve
		utterThis.onerror = reject
		synth.speak(utterThis)
	})
}
