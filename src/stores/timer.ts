import {defineStore} from 'pinia'
import {readonly, ref} from 'vue'

export const useTimerStore = defineStore('timer', () => {
	const current = ref(0)

	setInterval(() => {
		current.value += 1000
	}, 1000)

	function reset() {
		current.value = 0
	}

	return {
		current: readonly(current),
		reset,
	}
})
