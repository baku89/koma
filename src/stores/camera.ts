import {useTethr} from '@tethr/vue3'
import {defineStore} from 'pinia'
import {Tethr, TethrDeviceType, TethrIdentifier} from 'tethr'
import {ref, watch} from 'vue'

import {useProjectStore} from './project'

export const useCameraStore = defineStore('camera', () => {
	const project = useProjectStore()

	// @tethr/vue3 now owns device matching (requestCamera accepts an identifier)
	// and exposes `isConnecting`, so the app no longer reaches into USB internals
	// or guards the auto-reconnect race itself.
	const {
		pairedCameras,
		requestCamera,
		isConnecting,
		close,
		camera: tethr,
		toggleLiveview,
		configs,
	} = useTethr()

	// Auto-reconnect to the project's remembered camera when it's available and
	// nothing is connected. Re-runs when the project (its `camera` identity)
	// changes or a device is plugged in. `prompt: false` keeps it silent — this
	// isn't a user gesture, so a picker would throw anyway.
	watch(
		() => [project.camera, pairedCameras.value] as const,
		() => {
			if (project.camera) connect(project.camera, {prompt: false})
		},
		{immediate: true}
	)

	async function connect(
		query: TethrDeviceType | TethrIdentifier,
		opts?: {prompt?: boolean}
	) {
		if (tethr.value || isConnecting.value) return
		await requestCamera(query, opts)
		if (tethr.value) await setupCamera(tethr.value)
	}

	async function setupCamera(cam: Tethr) {
		cam.setLog(false)

		const model = await cam.getModel()

		// Remember this exact camera so we can reconnect to it next time.
		project.camera = {...cam.identifier, model: model ?? undefined}

		// importConfigs() now verifies and retries each write itself (see
		// TethrSigma), so the old "set white balance again after a delay"
		// workaround is no longer needed.
		await cam.importConfigs(project.cameraConfigs)

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

	/** Connect to a specific already-paired camera, switching if needed. */
	async function connectCamera(cam: Tethr) {
		if (isConnecting.value || tethr.value === cam) return
		if (tethr.value) await close()
		await connect(cam.identifier, {prompt: false})
	}

	function disconnect() {
		return close()
	}

	/** Prompt to grant/select a new device of the given type and connect to it. */
	async function grant(type: TethrDeviceType) {
		if (isConnecting.value) return
		if (tethr.value) await close()
		await connect(type)
	}

	// Bumped to ask the title-bar connection popup to open (and flash for
	// attention) — e.g. from the "Connect to Camera" button shown in Camera
	// Control while disconnected. A nonce so repeated requests each re-trigger.
	const connectPromptNonce = ref(0)

	function promptConnect() {
		connectPromptNonce.value++
	}

	return {
		tethr,
		pairedCameras,
		isConnecting,
		connectCamera,
		disconnect,
		grant,
		toggleLiveview,
		connectPromptNonce,
		promptConnect,

		// All camera configs from @tethr/vue3
		...configs,
	}
})
