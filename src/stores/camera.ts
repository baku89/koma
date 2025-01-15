import sleep from 'p-sleep'
import {defineStore} from 'pinia'
import {
	ConfigDesc,
	ConfigDescOption,
	ConfigName,
	ConfigType,
	Tethr,
	TethrDeviceType,
	TethrManager,
} from 'tethr'
import {readonly, Ref, shallowReactive, shallowRef, watch} from 'vue'

import {debounceAsync} from '@/utils'

import {useProjectStore} from './project'

export interface Config<T> {
	writable: boolean
	value: T | null
	set: (value: T) => void
	option?: ConfigDescOption<T>
}

function useConfig<N extends ConfigName>(
	camera: Ref<Tethr | null>,
	name: N
): Config<ConfigType[N]> {
	const config = shallowReactive<Config<ConfigType[N]>>({
		writable: false,
		value: null,
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

			const {fn: set, isExecuting: isSetting} = debounceAsync(
				(value: ConfigType[N]) => {
					return camera.set(name, value)
				},
				{
					onQueue(value) {
						config.value = value
					},
				}
			)

			config.set = set

			camera.on(`${name}Change` as any, (desc: ConfigDesc<ConfigType[N]>) => {
				if (isSetting.value) return

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
	const project = useProjectStore()

	const manager = new TethrManager()

	const tethr = shallowRef<Tethr | null>(null)

	const pairedCameras = shallowRef<Tethr[]>([])
	manager.on('pairedCameraChange', cameras => {
		pairedCameras.value = cameras
	})

	// Automatically connect
	watch(
		() => [project.cameraConfigs.model, pairedCameras.value] as const,
		async ([model], prev) => {
			if (!model || tethr.value) return
			if (prev?.[0] === model) return

			connectPreconfiguredCamera()
		},
		{immediate: true}
	)

	async function connectPreconfiguredCamera() {
		for await (const cam of pairedCameras.value) {
			if ((await cam.getModel()) === project.cameraConfigs.model) {
				openCamera(cam)
				break
			}
		}
	}

	async function openCamera(cam: Tethr) {
		cam.setLog(false)

		await cam.open()

		const model = await cam.getModel()

		await cam.importConfigs(project.cameraConfigs)

		/** TODO: Fix this */
		if (
			project.cameraConfigs.whiteBalance &&
			project.cameraConfigs.whiteBalance !== 'manual'
		) {
			await sleep(500)
			await cam.setWhiteBalance(project.cameraConfigs.whiteBalance)
		}

		saveConfigs()

		async function saveConfigs() {
			project.cameraConfigs = {
				model: model ?? undefined,
				...(await cam.exportConfigs()),
			}
		}

		cam.on('disconnect', () => {
			tethr.value = null
		})
		cam.on('change', saveConfigs)

		tethr.value = cam
		;(window as any).cam = cam

		await cam.startLiveview()
	}

	async function toggleConnection(type: TethrDeviceType = 'ptpusb') {
		if (tethr.value) {
			await tethr.value.close()
			tethr.value = null
			return
		}

		let cam: Tethr

		try {
			const ptpusb = await manager.requestCamera(type)
			if (ptpusb) {
				cam = ptpusb
			} else {
				throw new Error('No camera detected')
			}
		} catch (err) {
			if (err instanceof Error) {
				alert(err.message)
			}
			return
		}

		openCamera(cam)
	}

	return {
		tethr,
		pairedCameras,
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
		autoFocusFrameCenter: useConfig(tethr, 'autoFocusFrameCenter'),
		autoFocusFrameSize: useConfig(tethr, 'autoFocusFrameSize'),
		focusMeteringMode: useConfig(tethr, 'focusMeteringMode'),
		canRunManualFocus: useConfig(tethr, 'canRunManualFocus'),
		canStartLiveview: useConfig(tethr, 'canStartLiveview'),
		manualFocusOptions: useConfig(tethr, 'manualFocusOptions'),
		shutterSound: useConfig(tethr, 'shutterSound'),
	}
})
