import {range} from 'lodash-es'
import {defineStore} from 'pinia'
import {useTweeq} from 'tweeq'
import {ref, watch, watchEffect} from 'vue'

import {useOscStore} from './osc'

export const useDmxStore = defineStore('dmx', () => {
	const Tq = useTweeq()
	const osc = useOscStore()

	const senders = osc.senders(
		Object.fromEntries(
			range(16).map(i => [
				`dmx${i + 1}`,
				{address: `/dmx${i + 1}`, type: 'f', default: 0},
			])
		)
	)

	const values = Object.values(senders)

	const cachedValues = values.map((_, i) => {
		return Tq.config.ref(`dmx${i + 1}`, 1)
	})

	// Temporary "blackout" — send 0 to every channel without touching the stored
	// levels, so the lights restore to exactly what they were when released. Not
	// persisted: a reload clears the blackout and the cached levels come back.
	const blackout = ref(false)
	let levelsBeforeBlackout: number[] | null = null

	watch(blackout, on => {
		if (on) {
			levelsBeforeBlackout = values.map(v => v.value)
			values.forEach(v => (v.value = 0))
		} else if (levelsBeforeBlackout) {
			levelsBeforeBlackout.forEach((level, i) => (values[i].value = level))
			levelsBeforeBlackout = null
		}
	})

	cachedValues.forEach((cache, i) => {
		values[i].value = cache.value
		watchEffect(() => {
			// Don't let the temporary blackout 0 overwrite the persisted level.
			if (blackout.value) return
			cache.value = values[i].value
		})
	})

	return {values, blackout}
})
