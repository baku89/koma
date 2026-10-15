import {describe, expect, it} from 'vitest'

import {frameAssetPath, layerAssetPath, layerDirName, legacyFrameAssetFilename} from './projectLayout'

describe('layerDirName', () => {
	it('keeps plain names', () => {
		expect(layerDirName('Main')).toBe('Main')
		expect(layerDirName('VICE_arcwave 1')).toBe('VICE_arcwave 1')
	})
	it('trims every kind of space and collapses runs', () => {
		expect(layerDirName('　261001_carve-test')).toBe('261001_carve-test')
		expect(layerDirName('  a \t b  ')).toBe('a b')
	})
	it('replaces characters file systems refuse', () => {
		expect(layerDirName('take 2: "final"/v1')).toBe('take 2_ _final__v1')
	})
	it('drops leading dots / underscores and trailing dots', () => {
		expect(layerDirName('._hidden')).toBe('hidden')
		expect(layerDirName('end...')).toBe('end')
		expect(layerDirName('')).toBe('Layer')
		expect(layerDirName('___')).toBe('Layer')
	})
	it('avoids taken names case-insensitively, and koma\'s own folders', () => {
		expect(layerDirName('main', ['Main'])).toBe('main 2')
		expect(layerDirName('Main', ['Main', 'main 2'])).toBe('Main 3')
		expect(layerDirName('previz')).toBe('previz 2')
		expect(layerDirName('_trash')).toBe('trash')
	})
})

describe('frameAssetPath', () => {
	const p = {name: 'film', assetLayout: 2 as const, layers: [{dir: 'Main'}, {dir: 'Test 1'}, {}]}
	it('puts frames in the layer folder by number', () => {
		expect(frameAssetPath(p, 0, 1, 'jpg')).toBe('Main/0001.jpg')
		expect(frameAssetPath(p, 1, 12, 'lv')).toBe('Test 1/0012.lv.jpg')
		expect(frameAssetPath(p, 1, 12, 'raw')).toBe('Test 1/0012.dng')
		expect(layerAssetPath('X', 3, 'jpg')).toBe('X/0003.jpg')
	})
	it('falls back to the flat name for a layer without a folder, and on layout 1', () => {
		expect(frameAssetPath(p, 2, 5, 'jpg')).toBe('film_layer=2_0005.jpg')
		expect(frameAssetPath({...p, assetLayout: 1}, 0, 5, 'lv')).toBe('film_layer=0_0005.lv.jpg')
		expect(legacyFrameAssetFilename('film', 0, 5, 'raw')).toBe('film_layer=0_0005.dng')
	})
})
