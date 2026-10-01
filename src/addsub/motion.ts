/**
 * How much the live view is moving, for the sequence's settle step (ADDSUB.md
 * §2 step 6): the camera hangs from a long vertical axis and keeps swinging
 * after the rig stops, for a time that depends on the move.
 *
 * The measure is the mean absolute difference between consecutive live view
 * frames, on a small greyscale copy. It never reaches zero — sensor noise is
 * always there — so "still" is judged against the level measured while the
 * rig was known to be at rest (before the move), not against a fixed number.
 */

const WIDTH = 160
const HEIGHT = 108

/** Mean absolute difference of two equally sized greyscale frames (0–255). */
export function frameDifference(a: Uint8Array, b: Uint8Array): number {
	const n = Math.min(a.length, b.length)
	if (n === 0) return 0
	let sum = 0
	for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i])
	return sum / n
}

export function median(values: readonly number[]): number {
	const s = [...values].sort((x, y) => x - y)
	const m = s.length >> 1
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export interface MotionMeter {
	/**
	 * Difference between the live view frame now and the last one sampled.
	 * Null when there is nothing new to compare: no frame yet, or the same
	 * frame as last time (sampling faster than the live view updates).
	 */
	sample(): number | null
	dispose(): void
}

export function createMotionMeter(stream: MediaStream): MotionMeter {
	const video = document.createElement('video')
	video.muted = true
	video.playsInline = true
	video.srcObject = stream
	void video.play().catch(() => {})

	const canvas = document.createElement('canvas')
	canvas.width = WIDTH
	canvas.height = HEIGHT
	const ctx = canvas.getContext('2d', {willReadFrequently: true})

	let previous: Uint8Array | null = null

	return {
		sample() {
			if (!ctx || video.readyState < 2 || video.videoWidth === 0) return null
			ctx.drawImage(video, 0, 0, WIDTH, HEIGHT)
			const {data} = ctx.getImageData(0, 0, WIDTH, HEIGHT)
			const grey = new Uint8Array(WIDTH * HEIGHT)
			for (let i = 0, p = 0; i < grey.length; i++, p += 4) {
				grey[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8
			}
			if (!previous) {
				previous = grey
				return null
			}
			const diff = frameDifference(previous, grey)
			// Identical pixels: the video has not advanced since the last sample.
			if (diff === 0) return null
			previous = grey
			return diff
		},
		dispose() {
			video.srcObject = null
		},
	}
}
