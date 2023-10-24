import {defineStore} from 'pinia'
import {ConfigDesc, ConfigName, ConfigType, detectCameras, Tethr} from 'tethr'
import {useAppConfigStore} from 'tweeq'
import {onUnmounted, reactive, readonly, Ref, shallowRef, watch} from 'vue'

import {debounceAsync} from '@/util'

export interface Config<T> {
	writable: boolean
	value: T | null
	set: (value: T) => Promise<void>
	option: ConfigDesc<T>['option']
}

export function useConfig<N extends ConfigName>(
	camera: Ref<Tethr | null>,
	name: N
): Config<ConfigType[N]> {
	const config = reactive({
		writable: false,
		value: null,
		set: async () => undefined,
		option: undefined,
	}) as Config<ConfigType[N]>

	watch(
		camera,
		async camera => {
			if (!camera) {
				config.writable = false
				config.value = null
				config.set = async () => undefined
				config.option = undefined
				return
			}

			const desc = await camera.getDesc(name)

			config.writable = desc.writable
			config.value = desc.value
			config.option = desc.option

			let targetValue: ConfigType[N] | null = null

			const setProp = debounceAsync(
				async (value: ConfigType[N]) => {
					await camera.set(name, value)
				},
				{
					onQueue(value) {
						targetValue = value
					},
					onFinish() {
						targetValue = null
					},
				}
			).fn

			config.set = async (value: ConfigType[N]) => {
				config.value = value
				setProp(value)
			}

			camera.on(`${name}Change` as any, (desc: ConfigDesc<ConfigType[N]>) => {
				const doSkip = targetValue !== null && targetValue !== desc.value

				if (doSkip) return

				config.value = desc.value
				config.writable = desc.writable
				config.option = desc.option
			})
		},
		{immediate: true}
	)

	return readonly(config) as Config<ConfigType[N]>
}

export const useCameraStore = defineStore('camera', () => {
	const tethr = shallowRef<Tethr | null>(null)

	const appConfig = useAppConfigStore()

	const liveviewMediaStream = shallowRef<null | MediaStream>(null)

	const configs = appConfig.ref<Partial<ConfigType>>('cameraConfigs', {
		exposureMode: 'M',
		aperture: 4,
		shutterSpeed: '1/30',
		iso: 100,
		whiteBalance: 'manual',
		colorTemperature: 5500,
		imageQuality: 'raw 14bit,fine',
	})

	async function toggleConnection() {
		if (tethr.value) {
			await tethr.value.close()
			tethr.value = null
			return
		}

		let tethrs: Tethr[]
		try {
			tethrs = await detectCameras()
			if (tethrs.length === 0) {
				throw new Error('No camera detected')
			}
		} catch (err) {
			if (err instanceof Error) {
				alert(err.message)
			}
			return
		}

		const cam = tethrs[0]
		cam.setLog(false)
		await cam.open()

		cam.on('disconnect', () => {
			tethr.value = null
		})
		cam.on('liveviewStreamUpdate', (ms: MediaStream | null) => {
			liveviewMediaStream.value = ms
		})
		cam.on('change', async () => {
			const exportedConfigs = (await tethr.value?.exportConfigs()) ?? {}

			configs.value = {
				...configs.value,
				...exportedConfigs,
			}
		})

		tethr.value = cam
		;(window as any).cam = cam

		await cam.importConfigs(configs.value)

		cam.startLiveview()
	}

	onUnmounted(() => {
		if (tethr.value) {
			tethr.value.close()
			tethr.value = null
		}
	})

	return {
		tethr,
		liveviewMediaStream,
		toggleConnection,

		// DPC
		manufacturer: useConfig(tethr, 'manufacturer'),
		model: useConfig(tethr, 'model'),
		serialNumber: useConfig(tethr, 'serialNumber'),
		exposureMode: useConfig(tethr, 'exposureMode'),
		driveMode: useConfig(tethr, 'driveMode'),
		aperture: useConfig(tethr, 'aperture'),
		shutterSpeed: useConfig(tethr, 'shutterSpeed'),
		iso: useConfig(tethr, 'iso'),
		exposureComp: useConfig(tethr, 'exposureComp'),
		whiteBalance: useConfig(tethr, 'whiteBalance'),
		colorTemperature: useConfig(tethr, 'colorTemperature'),
		colorMode: useConfig(tethr, 'colorMode'),
		imageSize: useConfig(tethr, 'imageSize'),
		imageAspect: useConfig(tethr, 'imageAspect'),
		imageQuality: useConfig(tethr, 'imageQuality'),
		captureDelay: useConfig(tethr, 'captureDelay'),
		facingMode: useConfig(tethr, 'facingMode'),
		focalLength: useConfig(tethr, 'focalLength'),
		focusDistance: useConfig(tethr, 'focusDistance'),
		focusPeaking: useConfig(tethr, 'focusPeaking'),
		liveviewMagnifyRatio: useConfig(tethr, 'liveviewMagnifyRatio'),
		liveviewEnabled: useConfig(tethr, 'liveviewEnabled'),
		liveviewSize: useConfig(tethr, 'liveviewSize'),
		destinationToSave: useConfig(tethr, 'destinationToSave'),
		batteryLevel: useConfig(tethr, 'batteryLevel'),
		canTakePhoto: useConfig(tethr, 'canTakePhoto'),
		canRunAutoFocus: useConfig(tethr, 'canRunAutoFocus'),
		canRunManualFocus: useConfig(tethr, 'canRunManualFocus'),
		canStartLiveview: useConfig(tethr, 'canStartLiveview'),
		manualFocusOptions: useConfig(tethr, 'manualFocusOptions'),
		shutterSound: useConfig(tethr, 'shutterSound'),
	}
})
