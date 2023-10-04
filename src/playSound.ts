import {Howl} from 'howler'

export function playSound(src: string) {
	const sound = new Howl({
		src: [src],
		volume: 0.5,
	})
	sound.play()
}
