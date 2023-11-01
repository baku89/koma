export function queryString(query: Record<string, string | number>) {
	return Object.entries(query)
		.map(([key, value]) => `${key}=${value}`)
		.join('&')
}

export function toTime(ms: number) {
	const sec = Math.floor(ms / 1000)
	const min = Math.floor(sec / 60)
	const hour = Math.floor(min / 60)

	return [
		hour ? String(hour) : false,
		String(min % 60).padStart(2, '0'),
		String(sec % 60).padStart(2, '0'),
	]
		.filter(Boolean)
		.join(':')
}
