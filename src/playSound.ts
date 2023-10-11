import {Howl} from 'howler'

export function playSound(src: string) {
	const sound = new Howl({
		src: [src],
		volume: 0.5,
	})
	sound.play()
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
