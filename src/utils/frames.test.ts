import {describe, expect, it} from 'vitest'

import {
	deleteFramesOnLayer,
	insertFramesOnLayer,
	shotsAtOrAfter,
	trimTrailingEmptyKomas,
} from './frames'

type K = {shots: (string | null)[]; backupShots?: unknown[]}
const mk = (): K => ({shots: []})

// Two layers: A has a0..a4 on frames 0-4, B has b0..b2 on frames 0-2 and b4 on frame 4.
function sample(): K[] {
	return [
		{shots: ['a0', 'b0']},
		{shots: ['a1', 'b1']},
		{shots: ['a2', 'b2']},
		{shots: ['a3', null]},
		{shots: ['a4', 'b4']},
	]
}
const layer = (komas: K[], i: number) => komas.map(k => k.shots[i] ?? null)

describe('insertFramesOnLayer', () => {
	it('moves only that layer, appending a koma when its last shot is pushed off the end', () => {
		const komas = sample()
		expect(insertFramesOnLayer(komas, 2, 0, mk)).toBe(3)
		expect(komas.length).toBe(6)
		expect(layer(komas, 0)).toEqual(['a0', 'a1', null, 'a2', 'a3', 'a4'])
		expect(layer(komas, 1)).toEqual(['b0', 'b1', 'b2', null, 'b4', null])
	})
	it('does nothing when the layer has no shot from there on', () => {
		const komas = sample()
		expect(insertFramesOnLayer(komas, 3, 1, mk)).toBe(1) // b4 moves
		expect(insertFramesOnLayer(komas, 6, 1, mk)).toBe(0)
		expect(komas.length).toBe(6)
	})
	it('can open several frames at once', () => {
		const komas = sample()
		expect(insertFramesOnLayer(komas, 0, 1, mk, 2)).toBe(4)
		expect(layer(komas, 1)).toEqual([null, null, 'b0', 'b1', 'b2', null, 'b4'])
		expect(layer(komas, 0)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', null, null])
	})
	it('counts what an insert would move', () => {
		expect(shotsAtOrAfter(sample(), 3, 1)).toBe(1)
		expect(shotsAtOrAfter(sample(), 0, 0)).toBe(5)
		expect(shotsAtOrAfter(sample(), 9, 0)).toBe(0)
	})
})

describe('deleteFramesOnLayer', () => {
	it('closes the gap on that layer only and returns the removed shots', () => {
		const komas = sample()
		expect(deleteFramesOnLayer(komas, 1, 1)).toEqual(['b1'])
		expect(layer(komas, 1)).toEqual(['b0', 'b2', null, 'b4', null])
		expect(layer(komas, 0)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4'])
		expect(komas.length).toBe(5)
	})
	it('removes a range', () => {
		const komas = sample()
		expect(deleteFramesOnLayer(komas, 1, 0, 3)).toEqual(['a1', 'a2', 'a3'])
		expect(layer(komas, 0)).toEqual(['a0', 'a4', null, null, null])
	})
	it('drops komas emptied at the end, but never the last one', () => {
		const komas: K[] = [{shots: ['a0', null]}, {shots: [null, 'b1']}, {shots: [null, 'b2']}]
		deleteFramesOnLayer(komas, 1, 1, 2)
		expect(komas.length).toBe(1)
		deleteFramesOnLayer(komas, 0, 0)
		expect(komas).toEqual([{shots: [null, null]}])
	})
	it('keeps a trailing koma that has backup shots', () => {
		const komas: K[] = [{shots: ['a0']}, {shots: [null], backupShots: [{}]}]
		expect(trimTrailingEmptyKomas(komas)).toBe(0)
	})
})
