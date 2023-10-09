import {
	ConfigDesc,
	ConfigDescOption,
	ConfigName,
	ConfigType,
	detectCameras,
	Tethr,
} from 'tethr'
import {
	onUnmounted,
	reactive,
	readonly,
	Ref,
	shallowRef,
	UnwrapRef,
	watch,
} from 'vue'

export interface Config<T> {
	writable: boolean
	value: T | null
	set: (value: T) => void
	option?: ConfigDescOption<T>
}

export function useConfig<N extends ConfigName>(
	camera: Ref<Tethr | null>,
	name: N
): Config<ConfigType[N]> {
	const config = reactive({
		writable: false,
		value: null,
		set: () => null,
		option: undefined,
	}) as Config<ConfigType[N]>

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

			config.set = (value: ConfigType[N]) => camera.set(name, value)

			camera.on(`${name}Change` as any, (desc: ConfigDesc<ConfigType[N]>) => {
				config.value = desc.value
				config.writable = desc.writable
				config.option = desc.option
			})
		},
		{immediate: true}
	)

	return readonly(config) as Config<ConfigType[N]>
}

export function useTethr(
	appStorage: <T>(name: string, defaultValue: T) => Ref<UnwrapRef<T>>
) {
	const camera = shallowRef<Tethr | null>(null)

	const liveviewMediaStream = shallowRef<null | MediaStream>(null)

	const configPresets = appStorage<Partial<ConfigType>>('configPresets', {
		exposureMode: 'M',
		aperture: 4,
		shutterSpeed: '1/30',
		iso: 100,
		whiteBalance: 'manual',
		colorTemperature: 5500,
		imageQuality: 'raw 14bit,fine',
	})

	async function toggleCameraConnection() {
		if (camera.value) {
			await camera.value.close()
			camera.value = null
			return
		}

		let cams: Tethr[]
		try {
			cams = await detectCameras()
			if (cams.length === 0) {
				throw new Error('No camera detected')
			}
		} catch (err) {
			if (err instanceof Error) {
				alert(err.message)
			}
			return
		}

		const cam = cams[0]
		cam.setLog(false)
		await cam.open()

		cam.on('disconnect', () => {
			camera.value = null
		})
		cam.on('liveviewStreamUpdate', (ms: MediaStream | null) => {
			liveviewMediaStream.value = ms
		})
		cam.on('change', async () => {
			configPresets.value = {
				...configPresets.value,
				...(await camera.value?.exportConfigs()),
			}
		})

		cam.importConfigs(configPresets.value)

		await cam.startLiveview()

		camera.value = cam
		;(window as any).cam = cam
	}

	onUnmounted(() => {
		if (camera.value) {
			camera.value.close()
			camera.value = null
		}
	})

	return {
		camera,
		// DPC
		configs: {
			manufacturer: useConfig(camera, 'manufacturer'),
			model: useConfig(camera, 'model'),
			serialNumber: useConfig(camera, 'serialNumber'),
			exposureMode: useConfig(camera, 'exposureMode'),
			driveMode: useConfig(camera, 'driveMode'),
			aperture: useConfig(camera, 'aperture'),
			shutterSpeed: useConfig(camera, 'shutterSpeed'),
			iso: useConfig(camera, 'iso'),
			exposureComp: useConfig(camera, 'exposureComp'),
			whiteBalance: useConfig(camera, 'whiteBalance'),
			colorTemperature: useConfig(camera, 'colorTemperature'),
			colorMode: useConfig(camera, 'colorMode'),
			imageSize: useConfig(camera, 'imageSize'),
			imageAspect: useConfig(camera, 'imageAspect'),
			imageQuality: useConfig(camera, 'imageQuality'),
			captureDelay: useConfig(camera, 'captureDelay'),
			facingMode: useConfig(camera, 'facingMode'),
			focalLength: useConfig(camera, 'focalLength'),
			focusDistance: useConfig(camera, 'focusDistance'),
			focusPeaking: useConfig(camera, 'focusPeaking'),
			liveviewMagnifyRatio: useConfig(camera, 'liveviewMagnifyRatio'),
			liveviewEnabled: useConfig(camera, 'liveviewEnabled'),
			liveviewSize: useConfig(camera, 'liveviewSize'),
			destinationToSave: useConfig(camera, 'destinationToSave'),
			batteryLevel: useConfig(camera, 'batteryLevel'),
			canTakePhoto: useConfig(camera, 'canTakePhoto'),
			canRunAutoFocus: useConfig(camera, 'canRunAutoFocus'),
			canRunManualFocus: useConfig(camera, 'canRunManualFocus'),
			canStartLiveview: useConfig(camera, 'canStartLiveview'),
			manualFocusOptions: useConfig(camera, 'manualFocusOptions'),
			shutterSound: useConfig(camera, 'shutterSound'),
		},
		liveviewMediaStream,
		toggleCameraConnection,
	}
}
