import {useTethr} from '@tethr/vue3'
import sleep from 'p-sleep'
import {defineStore} from 'pinia'
import {Tethr, TethrDeviceType} from 'tethr'
import {watch} from 'vue'

import {useProjectStore} from './project'

export const useCameraStore = defineStore('camera', () => {
	const project = useProjectStore()

	// Use @tethr/vue3 hook for camera management
	const {
		pairedCameras,
		requestCamera,
		open,
		close,
		camera: tethr,
		toggleLiveview,
		configs,
	} = useTethr()

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

		await open(cam)

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

		cam.on('change', saveConfigs)
		;(window as any).cam = cam

		await cam.startLiveview()
	}

	async function toggleConnection(type: TethrDeviceType = 'ptpusb') {
		if (tethr.value) {
			await close()
			return
		}

		try {
			await requestCamera(type)
			console.log('tethr.value', tethr.value)
			// The camera will be automatically set in tethr.value by useTethr
			if (tethr.value) {
				await openCamera(tethr.value)
			}
		} catch (err) {
			if (err instanceof Error) {
				alert(err.message)
			}
			return
		}
	}

	return {
		tethr,
		pairedCameras,
		toggleConnection,
		toggleLiveview,

		// All camera configs from @tethr/vue3
		...configs,
	}
})
