<script lang="ts" setup>
import Tq from 'tweeq'

import {useCameraStore} from '@/stores/camera'

import TethrConfig from './TethrConfig.vue'

const camera = useCameraStore()
</script>

<template>
	<Tq.ParameterHeading>Camera Control</Tq.ParameterHeading>
	<Tq.Parameter label="Mode" icon="material-symbols:settings-photo-camera">
		<TethrConfig :config="camera.exposureMode" />
	</Tq.Parameter>
	<Tq.Parameter label="Exp." icon="material-symbols:exposure">
		<TethrConfig :config="camera.exposureComp" />
	</Tq.Parameter>
	<Tq.Parameter label="F.L." icon="lucide:focus">
		<TethrConfig :config="camera.focalLength" name="focalLength" />
	</Tq.Parameter>
	<Tq.Parameter label="F.D." icon="tabler:frustum">
		<TethrConfig :config="camera.focusDistance" name="focusDistance" />
	</Tq.Parameter>
	<Tq.Parameter label="Apr." icon="ph:aperture">
		<TethrConfig :config="camera.aperture" name="aperture" />
	</Tq.Parameter>
	<Tq.Parameter label="SS" icon="material-symbols:shutter-speed">
		<TethrConfig :config="camera.shutterSpeed" name="shutterSpeed" />
	</Tq.Parameter>
	<Tq.Parameter label="WB" icon="subway:black-white">
		<TethrConfig :config="camera.whiteBalance" name="whiteBalance" />
	</Tq.Parameter>
	<Tq.Parameter label="C.Temp" icon="mdi:temperature">
		<TethrConfig :config="camera.colorTemperature" name="colorTemperature" />
	</Tq.Parameter>
	<Tq.Parameter label="ISO" icon="carbon:iso">
		<TethrConfig :config="camera.iso" name="iso" />
	</Tq.Parameter>
	<Tq.Parameter label="Quality" icon="mdi:image">
		<TethrConfig :config="camera.imageQuality" name="imageQuality" />
	</Tq.Parameter>
	<Tq.Parameter label="Vol." icon="ic:baseline-volume-up">
		<TethrConfig :config="camera.shutterSound" name="shutterSound" />
	</Tq.Parameter>
</template>
