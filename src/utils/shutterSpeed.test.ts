import {expect, it} from 'vitest'

import {shutterSpeedToSeconds} from './shutterSpeed'

it('reads whole and fractional stops', () => {
	expect(shutterSpeedToSeconds('1/8000')).toBe(1 / 8000)
	expect(shutterSpeedToSeconds('1/1.3')).toBeCloseTo(0.769, 3)
	expect(shutterSpeedToSeconds('30')).toBe(30)
	expect(shutterSpeedToSeconds('2.5')).toBe(2.5)
})

it('has no time for the rest', () => {
	expect(shutterSpeedToSeconds('bulb')).toBeNull()
	expect(shutterSpeedToSeconds('sync')).toBeNull()
	expect(shutterSpeedToSeconds(null)).toBeNull()
	expect(shutterSpeedToSeconds(undefined)).toBeNull()
})
