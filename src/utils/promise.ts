import {readonly, ref} from 'vue'

export function mapPromises<T, U>(
	array: T[],
	fn: (item: T, index: number) => Promise<U> | U
): Promise<U[]> {
	return Promise.all(array.map(fn))
}

export async function mapValuePromises<T, U>(
	object: Record<string, T>,
	fn: (item: T, key: string) => Promise<U> | U
): Promise<Record<string, U>> {
	const entries = await Promise.all(
		Object.entries(object).map(async ([key_1, value_1]) => {
			const result = await fn(value_1, key_1)
			return [key_1, result] as const
		})
	)
	return Object.fromEntries(entries)
}

interface DebounceAsyncOptions<T extends unknown[]> {
	onQueue?: (...args: T) => any
	onFinish?: () => any
}

export function debounceAsync<T extends unknown[]>(
	fn: (...args: T) => Promise<any>,
	options?: DebounceAsyncOptions<T>
) {
	const isExecuting = ref(false)
	let reservedArgs: T | null = null

	const debouncedFn = async (...args: T) => {
		options?.onQueue && options.onQueue(...args)

		if (isExecuting.value) {
			reservedArgs = args
			return
		}

		try {
			isExecuting.value = true
			await fn(...args)
		} finally {
			isExecuting.value = false
		}

		if (reservedArgs) {
			const args = reservedArgs
			reservedArgs = null
			await debouncedFn(...args)
		} else {
			options?.onFinish && options.onFinish()
		}
	}

	return {fn: debouncedFn, isExecuting: readonly(isExecuting)}
}

/**
 * Prevents an async function from being executed concurrently. If it is executed concurrently, onConcurrentExecution is called.
 */
export function preventConcurrentExecution<T extends unknown[], R>(
	fn: (...arg: T) => Promise<R>,
	onConcurrentExecution: () => R = () => {
		throw new Error('Function is already executed')
	}
) {
	const isExecuting = ref(false)

	const singleFn = async (...arg: T): Promise<R> => {
		if (isExecuting.value) {
			return onConcurrentExecution()
		}

		try {
			isExecuting.value = true
			return await fn(...arg)
		} finally {
			isExecuting.value = false
		}
	}

	return {fn: singleFn, isExecuting: readonly(isExecuting)}
}
