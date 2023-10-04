import {computed, Ref, ref} from 'vue'

export function refWithSetter<T>(initialValue: T, setter: (value: T) => T) {
	const r = ref(initialValue) as Ref<T>

	const c = computed<T>({
		get() {
			return r.value
		},
		set(value: T) {
			r.value = setter(value)
		},
	})

	return c
}
