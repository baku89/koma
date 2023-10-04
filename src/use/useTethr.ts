import {
	ConfigDesc,
	ConfigDescOption,
	ConfigName,
	ConfigType,
	detectCameras,
	Tethr,
} from 'tethr'
import {onUnmounted, reactive, readonly, Ref, shallowRef, watch} from 'vue'
;('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=')

export interface TethrConfig<T> {
	writable: boolean
	value: T | null
	update: (value: T) => void
	option?: ConfigDescOption<T>
}

export function useTethrConfig<N extends ConfigName>(
	camera: Ref<Tethr | null>,
	name: N
) {
	const config = reactive({
		writable: false,
		value: null,
		update: () => null,
		option: undefined,
	}) as TethrConfig<ConfigType[N]>

	watch(
		camera,
		async cam => {
			if (!cam) {
				config.writable = false
				config.value = null
				config.option = undefined
				return
			}

			const desc = await cam.getDesc(name)

			config.writable = desc.writable
			config.value = desc.value
			config.option = desc.option

			config.update = (value: ConfigType[N]) => cam.set(name, value)

			cam.on(`${name}Changed` as any, (desc: ConfigDesc<ConfigType[N]>) => {
				config.value = desc.value
				config.writable = desc.writable
				config.option = desc.option
			})
		},
		{immediate: true}
	)

	return readonly(config)
}

export function useTethr() {
	const camera = shallowRef<Tethr | null>(null)

	const liveviewMediaStream = shallowRef<null | MediaStream>(null)

	async function toggleCameraConnection() {
		if (camera.value && camera.value.opened) {
			await camera.value.close()
			camera.value = null
			return
		}
		if (!camera.value) {
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
			await cam.open()

			cam.on('disconnect', () => {
				camera.value = null
			})
			cam.on('liveviewStreamUpdate', (ms: MediaStream | null) => {
				liveviewMediaStream.value = ms
			})

			await cam.setExposureMode('M')
			await cam.setAperture(9)
			await cam.setShutterSpeed('1/60')
			await cam.setIso(100)
			await cam.startLiveview()

			camera.value = cam
			;(window as any).cam = cam
		}
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
			manufacturer: useTethrConfig(camera, 'manufacturer'),
			model: useTethrConfig(camera, 'model'),
			serialNumber: useTethrConfig(camera, 'serialNumber'),
			exposureMode: useTethrConfig(camera, 'exposureMode'),
			driveMode: useTethrConfig(camera, 'driveMode'),
			aperture: useTethrConfig(camera, 'aperture'),
			shutterSpeed: useTethrConfig(camera, 'shutterSpeed'),
			iso: useTethrConfig(camera, 'iso'),
			exposureComp: useTethrConfig(camera, 'exposureComp'),
			whiteBalance: useTethrConfig(camera, 'whiteBalance'),
			colorTemperature: useTethrConfig(camera, 'colorTemperature'),
			colorMode: useTethrConfig(camera, 'colorMode'),
			imageSize: useTethrConfig(camera, 'imageSize'),
			imageAspect: useTethrConfig(camera, 'imageAspect'),
			imageQuality: useTethrConfig(camera, 'imageQuality'),
			captureDelay: useTethrConfig(camera, 'captureDelay'),
			timelapseNumber: useTethrConfig(camera, 'timelapseNumber'),
			timelapseInterval: useTethrConfig(camera, 'timelapseInterval'),
			facingMode: useTethrConfig(camera, 'facingMode'),
			focalLength: useTethrConfig(camera, 'focalLength'),
			focusDistance: useTethrConfig(camera, 'focusDistance'),
			focusPeaking: useTethrConfig(camera, 'focusPeaking'),
			liveviewMagnifyRatio: useTethrConfig(camera, 'liveviewMagnifyRatio'),
			liveviewEnabled: useTethrConfig(camera, 'liveviewEnabled'),
			liveviewSize: useTethrConfig(camera, 'liveviewSize'),
			destinationToSave: useTethrConfig(camera, 'destinationToSave'),
			batteryLevel: useTethrConfig(camera, 'batteryLevel'),
			canTakePhoto: useTethrConfig(camera, 'canTakePhoto'),
			canRunAutoFocus: useTethrConfig(camera, 'canRunAutoFocus'),
			canRunManualFocus: useTethrConfig(camera, 'canRunManualFocus'),
			canStartLiveview: useTethrConfig(camera, 'canStartLiveview'),
			manualFocusOptions: useTethrConfig(camera, 'manualFocusOptions'),
			shutterSound: useTethrConfig(camera, 'shutterSound'),
		},
		liveviewMediaStream,
		toggleCameraConnection,
	}
}
