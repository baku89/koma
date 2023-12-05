import {vec3} from 'linearly'
import {defineStore} from 'pinia'
import saferEval from 'safer-eval'
import {computed} from 'vue'

import {useCameraStore} from './camera'
import {useProjectStore} from './project'
import {useTimerStore} from './timer'
import {useViewportStore} from './viewport'
import {useTrackerStore} from './tracker'

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

	const alerts = computed(() =>
		canCheckShoot.value({project, viewport, camera, timer, tracker})
	)

	const canShoot = computed(() => alerts.value.length === 0)

	return {
		alerts,
		canShoot,
	}
})
