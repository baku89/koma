import {vec3} from 'linearly'
import {defineStore} from 'pinia'
import saferEval from 'safer-eval'
import {computed} from 'vue'

import {useAuxStore} from './aux'
import {useCameraStore} from './camera'
import {useProjectStore} from './project'
import {useTimerStore} from './timer'
import {useViewportStore} from './viewport'

interface Stores {
	project: ReturnType<typeof useProjectStore>
	viewport: ReturnType<typeof useViewportStore>
	camera: ReturnType<typeof useCameraStore>
	timer: ReturnType<typeof useTimerStore>
	aux: ReturnType<typeof useAuxStore>
}

type CanShootFn = (stores: Stores) => string[]

export const useShootAlertsStore = defineStore('shootAlerts', () => {
	const project = useProjectStore()
	const viewport = useViewportStore()
	const camera = useCameraStore()
	const timer = useTimerStore()
	const aux = useAuxStore()

	const canCheckShoot = computed(
		() => saferEval(project.shootCondition, {vec3}) as CanShootFn
	)

	const alerts = computed(() =>
		canCheckShoot.value({project, viewport, camera, timer, aux})
	)

	const canShoot = computed(() => alerts.value.length === 0)

	return {
		alerts,
		canShoot,
	}
})
