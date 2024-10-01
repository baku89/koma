import {mapValues} from 'lodash-es'
import OSC from 'osc-js'
import {defineStore} from 'pinia'
import {computed, Ref, ref, watch} from 'vue'

import {setIntervalImmediate} from '@/utils'

type OscArgTypeMap = {
	f: number
	b: boolean
	ff: readonly [number, number]
	fff: readonly [number, number, number]
	ffff: readonly [number, number, number, number]
}

type OSCArgType = keyof OscArgTypeMap

interface Option<T extends OSCArgType> {
	address: string
	type: T
	default: OscArgTypeMap[T]
}

interface OscMessageScheme<T extends OSCArgType = OSCArgType> {
	[key: string]: Option<T>
}

type OscMessageResult<Scheme extends OscMessageScheme> = {
	[K in keyof Scheme]: Ref<OscArgTypeMap[Scheme[K]['type']]>
}

export const useOscStore = defineStore('osc', () => {
	const osc = new OSC()
	const oscRef = ref<OSC | null>(null)

	let reconnectTimer: NodeJS.Timeout

	watch(
		oscRef,
		oscRef => {
			clearInterval(reconnectTimer)
			if (oscRef) return

			reconnectTimer = setIntervalImmediate(() => {
				osc.open()
			}, 2000)
		},
		{immediate: true}
	)

	osc.on('open', () => {
		oscRef.value = osc
	})

	osc.on('close', () => {
		oscRef.value = null
	})

	osc.on('error', () => {
		osc.close()
		oscRef.value = null
	})

	const connected = computed(() => !!oscRef.value)

	const receivedMessages = ref<Record<string, any>>({})

	osc.on('*', (e: unknown) => {
		if (e instanceof OSC.Message) {
			const args = e.args.length === 1 ? e.args[0] : e.args
			receivedMessages.value[e.address] = args
		}
	})

	function receivers<S extends OscMessageScheme>(
		scheme: S
	): OscMessageResult<S> {
		return mapValues(scheme, option => {
			return computed(() => {
				// TODO: check if the type of messages is correct
				return receivedMessages.value[option.address] ?? option.default
			})
		})
	}

	function senders<S extends OscMessageScheme>(scheme: S) {
		const ret = mapValues(scheme, option => {
			return ref(option.default)
		}) as OscMessageResult<S>

		for (const [key, r] of Object.entries(ret)) {
			const address = scheme[key].address
			watch(
				[oscRef, r],
				([osc, r]) => {
					osc?.send(new OSC.Message(address, r))
				},
				{immediate: true}
			)
		}

		return ret
	}

	return {osc, connected, receivers, senders}
})
