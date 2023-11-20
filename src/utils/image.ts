import {vec2} from 'linearly'

let canvas: HTMLCanvasElement | null = null

export async function resizeBlobImage(blob: Blob, size: vec2) {
	if (!canvas) {
		canvas = document.createElement('canvas')
	}

	const [width, height] = size

	canvas.width = width
	canvas.height = height

	const ctx = canvas.getContext('2d')!
	ctx.drawImage(await createImageBitmap(blob), 0, 0, width, height)

	return await new Promise<Blob>((resolve, reject) => {
		canvas!.toBlob(b => (b ? resolve(b) : reject()), 'image/jpeg', 0.9)
	})
}
