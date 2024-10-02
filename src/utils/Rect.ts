import {mat2d, vec2} from 'linearly'

export type Rect = readonly [min: vec2, max: vec2]

export namespace Rect {
	/**
	 * Like CSS's object-fit property, it computes the trannsformation matrix to fit the source rectangle into the container rectangle.
	 * @param source
	 * @param container
	 *
	 * @see https://developer.mozilla.org/en-US/docs/Web/CSS/object-fit
	 *
	 */
	export function objectFit(
		source: Rect,
		container: Rect,
		type: 'fill' | 'contain' | 'cover' = 'contain'
	): mat2d {
		switch (type) {
			case 'contain': {
				const [sourceMin, sourceMax] = source
				const [containerMin, contianrMax] = container

				const sourceSize = vec2.sub(sourceMax, sourceMin)
				const sourceAspect = sourceSize[0] / sourceSize[1]

				const containerSize = vec2.sub(contianrMax, containerMin)
				const containerAspect = containerSize[0] / containerSize[1]

				const scale = vec2.clone(vec2.div(containerSize, sourceSize))

				if (sourceAspect < containerAspect) {
					scale[0] = scale[1]
				} else {
					scale[1] = scale[0]
				}

				const offset = vec2.add(
					vec2.scale(vec2.sub(containerSize, vec2.mul(sourceSize, scale)), 0.5),
					vec2.mul(vec2.neg(sourceMin), scale)
				)

				return mat2d.trs(offset, 0, scale)
			}
		}

		throw new Error('Not implemented')
	}

	export function fromSize(size: vec2): Rect {
		return [vec2.zero, size]
	}

	export function center(rect: Rect): vec2 {
		return vec2.lerp(rect[0], rect[1], 0.5)
	}

	export function scale(
		rect: Rect,
		scale: number | vec2,
		origin: vec2 = [0, 0]
	): Rect {
		if (typeof scale === 'number') {
			scale = [scale, scale]
		}

		const xform = mat2d.scale(mat2d.id, scale, origin)

		const [min, max] = rect

		return [vec2.transformMat2d(min, xform), vec2.transformMat2d(max, xform)]
	}
}
