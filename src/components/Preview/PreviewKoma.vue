<script setup lang="ts">
import {asyncComputed} from '@vueuse/core'
import * as Tq from 'tweeq'
import {computed} from 'vue'

import {useCameraStore} from '@/stores/camera'
import {Shot, useProjectStore} from '@/stores/project'
import {useViewportStore} from '@/stores/viewport'
import {resolveAssetUrl} from '@/utils'

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

const layers = asyncComputed<Layer[]>(async () => {
	const {komas, captureShot} = project

	void (komas as unknown)

	// Visible layers in display order up to the current one (or the capture
	// layer's stack when this is the capture frame).
	const indices = project.compositeLayers(
		captureShot.frame === props.frame ? captureShot.layer : viewport.currentLayer
	)

	const layers: Layer[] = []

	for (const layer of indices) {
		const shot: Shot | null = project.shot(props.frame, layer)

		const {opacity, mixBlendMode} = project.layerView(layer)

		if (captureShot.frame === props.frame && captureShot.layer === layer) {
			layers.push({
				type: 'lv',
				opacity,
				mixBlendMode,
			})
		} else if (shot) {
			// Regenerate the lv from the hi-res jpg if its file is missing.
			if (!viewport.enableHiRes) await project.ensureLv(props.frame, layer)
			const src = await resolveAssetUrl(
				viewport.enableHiRes ? shot.jpg : shot.lv
			)
			if (src) {
				layers.push({
					type: 'jpg',
					src,
					opacity,
					mixBlendMode,
				})
			}
		}
	}

	return layers
}, [])

const style = computed(() => {
	return {
		transform: `scale(${project.viewport.zoom})`,
	}
})
</script>

<template>
	<div class="PreviewKoma" :style="style" v-show="layers.length > 0">
		<div
			v-for="(layer, index) in layers"
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
