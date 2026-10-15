import {describe, expect, it} from 'vitest'

import {detectLanguage} from './language'

describe('detectLanguage', () => {
	it('ignores punctuation, digits and symbols', () => {
		expect(detectLanguage('Cut #47 · stopped')).toBe('en')
		expect(detectLanguage('Frame 41: G-code … not cut yet')).toBe('en')
		expect(detectLanguage('Camera not moved, the plan is 123 millimetres away')).toBe('en')
		expect(detectLanguage('−2:10 (stopped at line 3/9)')).toBe('en')
	})

	it('tells Japanese from Chinese by kana', () => {
		expect(detectLanguage('切削が終わりました')).toBe('ja')
		expect(detectLanguage('カメラ未接続')).toBe('ja')
		expect(detectLanguage('切削完成')).toBe('zh')
		expect(detectLanguage('切削完成', {han: 'ja'})).toBe('ja')
	})

	it('prefers a non-Latin script over Latin when both occur', () => {
		expect(detectLanguage('Frame 41 の切削')).toBe('ja')
		expect(detectLanguage('Box Rig 準備完了', {han: 'ja'})).toBe('ja')
	})

	it('maps other scripts', () => {
		expect(detectLanguage('준비 완료')).toBe('ko')
		expect(detectLanguage('Резка остановлена')).toBe('ru')
		expect(detectLanguage('Ολοκληρώθηκε')).toBe('el')
	})

	it('falls back for Latin and for text with no letters', () => {
		expect(detectLanguage('Schnitt beendet')).toBe('en')
		expect(detectLanguage('Schnitt beendet', {latin: 'de'})).toBe('de')
		expect(detectLanguage('123')).toBe('en')
		expect(detectLanguage('')).toBe('en')
	})
})
