import {quat} from 'linearly'
import {defineStore} from 'pinia'
import {computed} from 'vue'

import {useOscStore} from './osc'

export const useAuxStore = defineStore('aux', () => {
	const osc = useOscStore()

	const tracker = osc.messages({
		position: {
			address: '/tracker0/position',
			type: 'fff',
			default: [0, 0, 0],
		},
		rotation: {
			address: '/tracker0/rotation',
			type: 'ffff',
			default: quat.identity,
		},
		enabled: {
			address: '/tracker0/enabled',
			type: 'b',
			default: false,
		},
	})

	return {
		tracker: {
			...tracker,
			enabled: computed(() => osc.connected && tracker.enabled.value),
		},
	}
})
