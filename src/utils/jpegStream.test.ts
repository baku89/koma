import {describe, expect, it} from 'vitest'

import {JpegStreamSplitter} from './jpegStream'

const jpeg = (payload: number[]) => new Uint8Array([0xff, 0xd8, ...payload, 0xff, 0xd9])

describe('JpegStreamSplitter', () => {
	it('splits pictures however the chunks fall', () => {
		const a = jpeg([1, 2, 0xff, 0x00, 3]) // a stuffed 0xFF inside
		const b = jpeg([4])
		const all = new Uint8Array([...a, ...b])
		for (const cut of [1, 2, 3, 6, 7, 8, 9, 10, 11]) {
			const s = new JpegStreamSplitter()
			s.push(all.subarray(0, cut))
			const first = s.next()
			s.push(all.subarray(cut))
			const got = [first, s.next(), s.next(), s.next()].filter(Boolean) as Uint8Array[]
			expect(got.map(g => [...g])).toEqual([[...a], [...b]])
			expect(s.next()).toBeNull()
		}
	})
	it('skips bytes before the first SOI', () => {
		const s = new JpegStreamSplitter()
		s.push(new Uint8Array([0, 0xff]))
		expect(s.next()).toBeNull()
		s.push(new Uint8Array([0xd8, 9, 0xff, 0xd9]))
		expect([...s.next()!]).toEqual([0xff, 0xd8, 9, 0xff, 0xd9])
	})
})
