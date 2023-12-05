import {vec2} from 'linearly'

let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null

async function removeExifOrientation(blob: Blob): Promise<Blob> {
	const dv = new DataView(await blob.arrayBuffer())
	let offset = 0,
		recess = 0

	const pieces: {recess: number; offset: number}[] = []
	let i = 0

	if (dv.getUint16(offset) === 0xffd8) {
		offset += 2
		let app1 = dv.getUint16(offset)
		offset += 2
		while (offset < dv.byteLength) {
			if (app1 === 0xffe1) {
				pieces[i] = {recess: recess, offset: offset - 2}
				recess = offset + dv.getUint16(offset)
				i++
			} else if (app1 === 0xffda) {
				break
			}
			offset += dv.getUint16(offset)
			app1 = dv.getUint16(offset)
			offset += 2
		}

		if (pieces.length > 0) {
			const newPieces: Blob[] = []
			pieces.forEach(v => {
				newPieces.push(blob.slice(v.recess, v.offset))
			}, blob)
			newPieces.push(blob.slice(recess))
			return new Blob(newPieces, {type: 'image/jpeg'})
		}
	}

	return blob
}

export async function resizeBlobImage(blob: Blob, size: vec2) {
	if (!canvas) {
		canvas = document.createElement('canvas')
	}

	const [width, height] = size

	canvas.width = width
	canvas.height = height

	ctx = canvas.getContext('2d')!

	const blobDeorient = await removeExifOrientation(blob)
	const bitmap = await createImageBitmap(blobDeorient)
	ctx.drawImage(bitmap, 0, 0, width, height)
	bitmap.close()

	return await new Promise<Blob>((resolve, reject) => {
		canvas!.toBlob(b => (b ? resolve(b) : reject()), 'image/jpeg', 0.9)
	})
}
