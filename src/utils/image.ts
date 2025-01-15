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

export async function resizeBlobImage(
	blob: Blob,
	size: vec2,
	mode: 'cover' | 'stretch' = 'cover'
) {
	if (!canvas) {
		canvas = document.createElement('canvas')
	}

	let [width, height] = size
	let x = 0
	let y = 0

	canvas.width = width
	canvas.height = height

	ctx = canvas.getContext('2d')!

	const blobDeorient = await removeExifOrientation(blob)
	const bitmap = await createImageBitmap(blobDeorient)

	if (mode === 'cover') {
		if (width / height > bitmap.width / bitmap.height) {
			height = (width * bitmap.height) / bitmap.width
			y = (canvas.height - height) / 2
		} else {
			width = (height * bitmap.width) / bitmap.height
			x = (canvas.width - width) / 2
		}
	}

	ctx.drawImage(bitmap, x, y, width, height)
	bitmap.close()

	return await new Promise<Blob>((resolve, reject) => {
		canvas!.toBlob(b => (b ? resolve(b) : reject()), 'image/jpeg', 0.9)
	})
}
