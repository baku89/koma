import {describe, expect, it} from 'vitest'

import {parseCameraPoseMessage} from './poseMessage'

const cal = {rigOffset: [0, -1300, 0] as [number, number, number]}

describe('parseCameraPoseMessage', () => {
	it('takes metres and a quaternion', () => {
		const p = parseCameraPoseMessage({position: [0.1, 0.2, 0.3], rotation: [0, 0, 0, 1], unit: 'm'}, cal)
		expect(p.position).toEqual([100, 200, 300])
		expect(p.rotation).toEqual([0, 0, 0, 1])
	})
	it('takes head angles and defaults to world mm', () => {
		const p = parseCameraPoseMessage({position: [1, 2, 3], angles: {tilt: 0, pan: 0, roll: 0}}, cal)
		expect(p.position).toEqual([1, 2, 3])
		expect(p.rotation.map(v => Math.round(v * 1e6) / 1e6)).toEqual([0, 0, 0, 1])
	})
	it("converts the rig frame with the rig offset and accepts the old 'film' name", () => {
		expect(parseCameraPoseMessage({position: [0, 0, 0], frame: 'rig'}, cal).position).toEqual([0, 1300, 0])
		expect(parseCameraPoseMessage({position: [5, 5, 5], frame: 'film'}, cal).position).toEqual([5, 5, 5])
	})
	it('rejects what it cannot read', () => {
		expect(() => parseCameraPoseMessage({position: [1, 2]}, cal)).toThrow('position')
		expect(() => parseCameraPoseMessage({position: [1, 2, 3], rotation: [1, 2, 3]}, cal)).toThrow('rotation')
		expect(() => parseCameraPoseMessage({position: [1, 2, 3], frame: 'moon'}, cal)).toThrow('frame')
	})
})
