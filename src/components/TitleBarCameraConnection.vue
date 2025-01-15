<script setup lang="ts">
import {asyncComputed} from '@vueuse/core'
import * as Tq from 'tweeq'
import {computed} from 'vue'

import {useCameraStore} from '@/stores/camera'

const camera = useCameraStore()

const icon = computed(() => {
	if (camera.tethr) {
		return camera.tethr.type === 'ptpusb' ? 'mdi:camera' : 'mdi:webcam'
	} else {
		return 'mdi:connection'
	}
})

const pairedCameraModels = asyncComputed(async () => {
	const names = await Promise.all(
		camera.pairedCameras.map(cam => cam.getModel())
	)
	return names.filter(name => name !== null)
})
</script>

<template>
	<Tq.InputGroup>
		<Tq.InputButton
			:icon="icon"
			:label="camera.model.value ?? 'Connect'"
			@click="camera.toggleConnection('ptpusb')"
		/>
		<vMenu>
			<Tq.InputButton
				icon="mdi:chevron-down"
				narrow
				@click="camera.toggleConnection('webcam')"
			/>
			<template #popper>
				<ul>
					<li v-for="cam in pairedCameraModels" :key="cam">{{ cam }}</li>
				</ul>
			</template>
		</vMenu>
	</Tq.InputGroup>
</template>
