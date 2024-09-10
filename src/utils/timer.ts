export function setIntervalImmediate(
	fn: () => void,
	interval: number
): NodeJS.Timeout {
	fn()
	return setInterval(fn, interval)
}
