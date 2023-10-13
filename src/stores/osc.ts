import {mapValues} from 'lodash'
import OSC from 'osc-js'
import {defineStore} from 'pinia'
import {computed, Ref, ref, watch} from 'vue'

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

	console.log('!!!')

	let reconnectTimer: NodeJS.Timeout

	watch(
		oscRef,
		oscRef => {
			if (oscRef) return

			clearInterval(reconnectTimer)
			osc.open()

			reconnectTimer = setInterval(() => {
				osc.open()
			}, 2000)
		},
		{immediate: true}
	)

	osc.on('open', () => {
		console.log('OPEN!!')
		clearInterval(reconnectTimer)
		oscRef.value = osc
	})

	osc.on('close', () => {
		oscRef.value = null
	})

	osc.on('error', () => {
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

	function messages<S extends OscMessageScheme>(
		scheme: S
	): OscMessageResult<S> {
		return mapValues(scheme, option => {
			console.log(scheme)

			return computed(() => {
				// TODO: check if the type of messages is correct
				return (receivedMessages as any).value[option.address] ?? option.default
			})
		})
	}

	return {osc, connected, messages}
})
