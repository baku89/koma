import {range} from 'lodash-es'
import {defineStore} from 'pinia'
import {useTweeq} from 'tweeq'
import {watchEffect} from 'vue'

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

	cachedValues.forEach((cache, i) => {
		values[i].value = cache.value
		watchEffect(() => {
			cache.value = values[i].value
		})
	})

	return {values}
})
