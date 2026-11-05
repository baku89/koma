/**
 * Exposure time of a shutter speed such as `1/8000`, `1/1.3`, `2.5` or `30`.
 * Null for anything without a time of its own (`bulb`, `sync`, `auto`).
 */
export function shutterSpeedToSeconds(ss?: string | null) {
	if (typeof ss !== 'string') return null

	const fraction = ss.match(/^1\/(\d+(?:\.\d+)?)$/)
	if (fraction) return 1 / parseFloat(fraction[1])

	return /^\d+(?:\.\d+)?$/.test(ss) ? parseFloat(ss) : null
}
