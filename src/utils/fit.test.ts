import {expect, it} from 'vitest'

import {fitContain} from './fit'

it('fits a 16:9 picture inside a 3:2 frame with bars top and bottom', () => {
	expect(fitContain(1920, 1080, 1920, 1280)).toEqual({x: 0, y: 100, width: 1920, height: 1080})
	expect(fitContain(960, 540, 1920, 1280)).toEqual({x: 0, y: 100, width: 1920, height: 1080})
	expect(fitContain(1000, 1000, 1920, 1280)).toEqual({x: 320, y: 0, width: 1280, height: 1280})
	expect(fitContain(3000, 2000, 1920, 1280)).toEqual({x: 0, y: 0, width: 1920, height: 1280})
})
