<script setup lang="ts">
import {asyncComputed} from '@vueuse/core'
import * as Tq from 'tweeq'
import {computed} from 'vue'

import {useCameraStore} from '@/stores/camera'
import {Shot, useProjectStore} from '@/stores/project'
import {useViewportStore} from '@/stores/viewport'
import {resolveAssetUrl} from '@/utils'
import {type LayerTransform, layerTransformCss} from '@/utils/layerTransform'

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
	transform?: LayerTransform
}

const layers = asyncComputed<Layer[]>(async () => {
	const {komas, captureShot} = project

	void (komas as unknown)

	// Visible layers in display order up to the current one (or the capture
	// layer's stack when this is the capture frame).
	const indices = project.compositeLayers(
		captureShot.frame === props.frame ? captureShot.layer : viewport.currentLayer
	)

	// Read everything reactive BEFORE the first await: asyncComputed only
	// tracks what is touched synchronously, so a blend / opacity / transform
	// read after an await would never trigger a recompute (until 2026-10-27
	// changing the second layer's opacity left the Preview as it was).
	const hiRes = viewport.enableHiRes
	const plan = indices.map(layer => {
		const shot: Shot | null = project.shot(props.frame, layer)
		const {opacity, mixBlendMode, transform} = project.layerView(layer)
		return {layer, shot, opacity, mixBlendMode, transform}
	})

	const layers: Layer[] = []

	for (const {layer, shot, opacity, mixBlendMode, transform} of plan) {
		if (captureShot.frame === props.frame && captureShot.layer === layer) {
			layers.push({
				type: 'lv',
				opacity,
				mixBlendMode,
				transform,
			})
		} else if (shot) {
			// Regenerate the lv from the hi-res jpg if its file is missing.
			if (!hiRes) await project.ensureLv(props.frame, layer)
			const src = await resolveAssetUrl(hiRes ? shot.jpg : shot.lv)
			if (src) {
				layers.push({
					type: 'jpg',
					src,
					opacity,
					mixBlendMode,
					transform,
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
				transform: layerTransformCss(layer.transform),
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
	// Whole picture, letter / pillar-boxed when its aspect differs from the project's.
	object-fit contain
	// Pixels as stored, like the lv: a camera JPEG's EXIF Orientation (a camera
	// on its side) is not applied, so Hi-Res never turns against the lv.
	image-orientation none

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
