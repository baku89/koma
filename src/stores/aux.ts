import {quat, vec3} from 'linearly'
import {defineStore} from 'pinia'
import {computed} from 'vue'

import {useOscStore} from './osc'

export const useAuxStore = defineStore('aux', () => {
	const osc = useOscStore()

	const tracker = osc.messages({
		position: {
			address: '/tracker0/position',
			type: 'fff',
			default: vec3.zero,
		},
		rotation: {
			address: '/tracker0/rotation',
			type: 'ffff',
			default: quat.identity,
		},
		velocity: {
			address: '/tracker0/velocity',
			type: 'fff',
			default: vec3.zero,
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
