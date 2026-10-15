/**
 * Guess the language a short piece of text was written in from the Unicode
 * script of its letters. Punctuation, digits and whitespace are ignored, so
 * "Cut #47 · stopped" is as English as "Cut stopped".
 *
 * Scripts map to one representative BCP 47 language each (Cyrillic → ru).
 * Two cases are ambiguous and take a default: Latin-script languages cannot
 * be told apart (`latin`, en), and kanji without any kana may be Japanese or
 * Chinese (`han`, zh; pass ja where the operators write Japanese).
 *
 * Non-Latin scripts win over Latin whenever they occur at all: an English
 * voice cannot read "切削" but a Japanese one reads "Frame 41" acceptably.
 */

const SCRIPTS: [lang: string, re: RegExp][] = [
	['ja', /\p{Script=Hiragana}|\p{Script=Katakana}/gu],
	['zh', /\p{Script=Han}/gu],
	['ko', /\p{Script=Hangul}/gu],
	['th', /\p{Script=Thai}/gu],
	['ar', /\p{Script=Arabic}/gu],
	['he', /\p{Script=Hebrew}/gu],
	['hi', /\p{Script=Devanagari}/gu],
	['el', /\p{Script=Greek}/gu],
	['ru', /\p{Script=Cyrillic}/gu],
	['hy', /\p{Script=Armenian}/gu],
	['ka', /\p{Script=Georgian}/gu],
	['bn', /\p{Script=Bengali}/gu],
	['ta', /\p{Script=Tamil}/gu],
]

export interface DetectLanguageOptions {
	/** Language for Latin-script text. Default `en`. */
	latin?: string
	/** Language for Han (kanji / hanzi) text without kana. Default `zh`. */
	han?: string
}

export function detectLanguage(
	text: string,
	{latin = 'en', han = 'zh'}: DetectLanguageOptions = {}
): string {
	const counts = new Map<string, number>()
	for (const [lang, re] of SCRIPTS) {
		const n = text.match(re)?.length ?? 0
		if (n > 0) counts.set(lang, n)
	}

	// Kanji in the company of kana are Japanese, not Chinese.
	const kana = counts.get('ja')
	if (kana) {
		counts.set('ja', kana + (counts.get('zh') ?? 0))
		counts.delete('zh')
	}

	let best: string | null = null
	let bestCount = 0
	for (const [lang, n] of counts) {
		if (n > bestCount) [best, bestCount] = [lang, n]
	}
	if (best === 'zh') return han
	return best ?? latin
}
