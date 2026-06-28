import {vec3} from 'linearly'
import {defineStore} from 'pinia'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import saferEval from 'safer-eval'
import {computed, ref} from 'vue'

import {useCameraStore} from './camera'
import {useProjectStore} from './project'
import {useTimerStore} from './timer'
import {useTrackerStore} from './tracker'
import {useViewportStore} from './viewport'

interface Stores {
	project: ReturnType<typeof useProjectStore>
	viewport: ReturnType<typeof useViewportStore>
	camera: ReturnType<typeof useCameraStore>
	timer: ReturnType<typeof useTimerStore>
	tracker: ReturnType<typeof useTrackerStore>
}

type CanShootFn = (stores: Stores) => string[]

export const useShootAlertsStore = defineStore('shootAlerts', () => {
	const project = useProjectStore()
	const viewport = useViewportStore()
	const camera = useCameraStore()
	const timer = useTimerStore()
	const tracker = useTrackerStore()

	const canCheckShoot = computed(
		() => saferEval(project.shootCondition, {vec3}) as CanShootFn
	)

	const alerts = computed(() => {
		try {
			return canCheckShoot.value({project, viewport, camera, timer, tracker})
		} catch (e) {
			// The shoot condition is user-editable JS and may throw (e.g. when a
			// koma has no tracker info). Surface the error as an alert instead of
			// letting it crash the preview render and block seeking.
			return [
				'Shoot condition error: ' +
					(e instanceof Error ? e.message : String(e)),
			]
		}
	})

	const canShoot = computed(() => alerts.value.length === 0)

	// Bumped whenever a shoot is blocked by these alerts. The preview watches it
	// to re-reveal the (possibly user-collapsed) alert pane so the reason the
	// shutter refused is back in view. A monotonic nonce, not a boolean, so two
	// failures in a row each fire the watcher.
	const revealNonce = ref(0)

	function requestReveal() {
		revealNonce.value++
	}

	return {
		alerts,
		canShoot,
		revealNonce,
		requestReveal,
	}
})
