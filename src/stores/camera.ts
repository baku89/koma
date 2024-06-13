import {defineStore} from 'pinia'
import {
	ConfigDesc,
	ConfigDescOption,
	ConfigName,
	ConfigType,
	Tethr,
	TethrManager,
} from 'tethr'
import {useAppConfigStore} from 'tweeq'
import {
	onUnmounted,
	readonly,
	Ref,
	shallowReactive,
	shallowRef,
	toRaw,
	watch,
} from 'vue'

import {debounceAsync} from '@/utils'

export interface Config<T> {
	writable: boolean
	value: T | null
	set: (value: T) => Promise<void>
	option: ConfigDesc<T>['option']
}

export interface TethrConfig<T> {
	writable: boolean
	value: T | null
	target: T | null
	set: (value: T) => void
	option?: ConfigDescOption<T>
}

function useConfig<N extends ConfigName>(
	camera: Ref<Tethr | null>,
	name: N
): TethrConfig<ConfigType[N]> {
	const config = shallowReactive<TethrConfig<ConfigType[N]>>({
		writable: false,
		value: null,
		target: null,
		set: () => null,
		option: undefined,
	})

	watch(
		camera,
		async camera => {
			if (!camera) {
				config.writable = false
				config.value = null
				config.option = undefined
				return
			}

			const desc = await camera.getDesc(name)

			config.writable = desc.writable
			config.value = desc.value
			config.option = desc.option

			const {fn: set} = debounceAsync(
				(value: ConfigType[N]) => {
					config.value = value
					return camera.set(name, value)
				},
				{
					onQueue(value) {
						config.target = value
					},
					onFinish() {
						config.target = null
					},
				}
			)

			config.set = set

			camera.on(`${name}Change` as any, (desc: ConfigDesc<ConfigType[N]>) => {
				const isSetting = config.target !== null && config.target !== desc.value

				if (isSetting) return

				config.value = desc.value
				config.writable = desc.writable
				config.option = desc.option
			})
		},
		{immediate: true}
	)

	return readonly(config) as TethrConfig<ConfigType[N]>
}

export const useCameraStore = defineStore('camera', () => {
	const manager = new TethrManager()

	const tethr = shallowRef<Tethr | null>(null)

	const appConfig = useAppConfigStore()

	const configs = appConfig.ref<Partial<ConfigType>>('cameraConfigs', {
		exposureMode: 'M',
		aperture: 4,
		shutterSpeed: '1/30',
		iso: 100,
		whiteBalance: 'fluorescent',
		colorTemperature: 5500,
		imageQuality: 'raw 14bit,fine',
	})

	async function toggleConnection() {
		if (tethr.value) {
			await tethr.value.close()
			tethr.value = null
			return
		}

		let cam: Tethr | null
		try {
			cam = await manager.requestCamera('ptpusb')
			if (!cam) {
				throw new Error('No camera detected')
			}
		} catch (err) {
			if (err instanceof Error) {
				alert(err.message)
			}
			return
		}

		cam.setLog(false)
		await cam.open()

		const initialConfigs = {...toRaw(configs.value)}

		// Remove colorTemperature if whiteBalance is not manual
		if (configs.value.whiteBalance !== 'manual') {
			delete initialConfigs['colorTemperature']
		}

		await cam.importConfigs(configs.value)

		cam.on('disconnect', () => {
			tethr.value = null
		})
		cam.on('change', async () => {
			const exportedConfigs = await tethr.value?.exportConfigs()

			configs.value = {
				...toRaw(configs.value),
				...exportedConfigs,
			}
		})

		tethr.value = cam
		;(window as any).cam = cam

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
		liveview: useConfig(tethr, 'liveview'),
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
