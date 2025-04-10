<script setup lang="ts">
import * as Tq from 'tweeq'
import {computed} from 'vue'

import {useCameraStore} from '@/stores/camera'
import {Shot, useProjectStore} from '@/stores/project'
import {useViewportStore} from '@/stores/viewport'
import {getObjectURL} from '@/utils'

interface Props {
	frame: number
}

const props = defineProps<Props>()

const project = useProjectStore()
const viewport = useViewportStore()
const camera = useCameraStore()

type Layer = ({type: 'jpg'; src: string} | {type: 'lv'}) & {
	opacity: number
	mixBlendMode: any
}

const layers = computed(() => {
	const {komas, captureShot} = project

	const shots: (Shot | null)[] = komas[props.frame]?.shots ?? []

	const layerCount = Math.max(
		shots.length,
		captureShot.frame === props.frame ? captureShot.layer + 1 : 0
	)

	const layers: Layer[] = []

	for (let layer = 0; layer < layerCount; layer++) {
		const shot = project.shot(props.frame, layer)

		const {opacity, mixBlendMode} = project.layer(layer)

		if (captureShot.frame === props.frame && captureShot.layer === layer) {
			layers.push({
				type: 'lv',
				opacity,
				mixBlendMode,
			})
		} else if (shot) {
			layers.push({
				type: 'jpg',
				src: getObjectURL(viewport.enableHiRes ? shot.jpg : shot.lv),
				opacity,
				mixBlendMode,
			})
		}
	}

	return layers
})

const style = computed(() => {
	return {
		transform: `scale(${project.viewport.zoom})`,
	}
})
</script>

<template>
	<div class="PreviewKoma" :style="style" v-show="layers.length > 0">
		<div
			v-for="(layer, index) in layers.slice(0, viewport.currentLayer + 1)"
			:key="index"
			class="layer"
			:style="{
				opacity: layer.opacity,
				mixBlendMode: layer.mixBlendMode,
			}"
		>
			<img v-if="layer.type === 'jpg'" :src="layer.src" />
			<video
				v-if="camera.liveview.value"
				v-show="layer.type === 'lv'"
				:srcObject.prop="camera.liveview.value"
				autoplay
				loop
				muted
				playsinline
			/>
			<div v-if="layer.type === 'lv' && !camera.liveview.value" class="no-lv">
				<Tq.Icon icon="mdi:camera-off" />
			</div>
		</div>
	</div>
</template>

<style scoped lang="stylus">
.PreviewKoma
	position absolute
	inset 0
	pointer-events none

.layer
img
video
.no-lv
	width 100%
	height 100%
	object-fit cover

.layer
	position absolute
	top 0
	left 0

.no-lv
	background black
	color var(--tq-color-text-mute)
	display flex
	justify-content center
	align-items center

	svg
		width 20% !important
		height 20% !important
</style>
