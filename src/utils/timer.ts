export function setIntervalImmediate(
	fn: () => void,
	interval: number
): ReturnType<typeof setInterval> {
	fn()
	return setInterval(fn, interval)
}
