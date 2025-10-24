<script setup lang="ts">
import * as Tq from 'tweeq'
import {computed, ref, watch} from 'vue'

import {useCameraStore} from '@/stores/camera'

const camera = useCameraStore()

const icon = computed(() => {
	if (camera.tethr) {
		return camera.tethr.type === 'ptpusb' ? 'mdi:camera' : 'mdi:webcam'
	} else {
		return 'mdi:connection'
	}
})

const pairedCameraModels = ref<string[]>([])

watch(camera.pairedCameras, async cameras => {
	const names = await Promise.all(cameras.map(cam => cam.getModel()))

	pairedCameraModels.value = ['Webcam', ...names.filter(name => name !== null)]
})
</script>

<template>
	<Tq.InputGroup>
		<Tq.InputButton
			:icon="icon"
			:label="camera.model.value ?? 'Connect'"
			@click="camera.toggleConnection('ptpusb')"
		/>
		<Tq.InputButton
			icon="mdi:webcam"
			narrow
			@click="camera.toggleConnection('webcam')"
		/>
		<!-- <vMenu>
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
		</vMenu> -->
	</Tq.InputGroup>
</template>
