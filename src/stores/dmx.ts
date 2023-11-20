import {range} from 'lodash'
import {defineStore} from 'pinia'

import {useOscStore} from './osc'

export const useDmxStore = defineStore('dmx', () => {
	const osc = useOscStore()

	const senders = osc.senders(
		Object.fromEntries(
			range(16).map(i => [
				`dmx${i}`,
				{address: `/dmx${i + 1}`, type: 'f', default: 0},
			])
		)
	)

	const values = Object.values(senders)

	return {values}
})
