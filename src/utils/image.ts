import {vec2} from 'linearly'

let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null

export async function resizeBlobImage(blob: Blob, size: vec2) {
	if (!canvas) {
		canvas = document.createElement('canvas')
	}

	const [width, height] = size

	canvas.width = width
	canvas.height = height

	ctx = canvas.getContext('2d')!

	const bitmap = await createImageBitmap(blob)
	ctx.drawImage(bitmap, 0, 0, width, height)
	bitmap.close()

	return await new Promise<Blob>((resolve, reject) => {
		canvas!.toBlob(b => (b ? resolve(b) : reject()), 'image/jpeg', 0.9)
	})
}
