export function assignReactive<T extends Record<string, any>>(
	reactive: T,
	source: T
) {
	for (const key of Object.keys(source)) {
		;(reactive as any)[key] = (source as any)[key]
	}
}
