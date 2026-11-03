<script setup lang="ts">
/**
 * Modeless editing of how a layer is shown in the active preset (blend,
 * opacity, scale / shift / rotation), in a balloon next to the layer's name
 * in the timeline (the sliders icon, or right-click the row).
 */
import * as Tq from 'tweeq'
import {computed} from 'vue'

import {MixBlendModeValues, useProjectStore} from '@/stores/project'
import {layerTransformOf} from '@/utils/layerTransform'

interface Props {
	reference: HTMLElement | null
	/** Storage index of the layer being edited, or null when closed. */
	layer: number | null
}

const props = defineProps<Props>()
const emit = defineEmits<{close: []}>()

const project = useProjectStore()

const view = computed(() => (props.layer === null ? null : project.layerView(props.layer)))
const transform = computed(() => layerTransformOf(view.value?.transform))
const name = computed(() => (props.layer === null ? '' : project.layer(props.layer)?.name ?? ''))

function setView(patch: Parameters<typeof project.setLayerView>[1]) {
	if (props.layer !== null) project.setLayerView(props.layer, patch)
}
function setTransform(patch: Parameters<typeof project.setLayerTransform>[1]) {
	if (props.layer !== null) project.setLayerTransform(props.layer, patch)
}
function removeFromTimeline() {
	if (props.layer === null) return
	project.setLayerOnTimeline(props.layer, false)
	emit('close')
}
</script>

<template>
	<Tq.Popover
		:reference="reference"
		:open="layer !== null"
		placement="right-start"
		arrow
		exit-transition
		@update:open="$event || emit('close')"
	>
		<div class="LayerViewPopover">
			<div class="name">{{ name }}</div>
			<Tq.ParameterGrid>
				<Tq.Parameter label="Blend" icon="mdi:set-center">
					<Tq.InputDropdown
						:modelValue="view?.mixBlendMode ?? 'normal'"
						:options="MixBlendModeValues"
						@update:modelValue="setView({mixBlendMode: $event})"
					/>
				</Tq.Parameter>
				<Tq.Parameter label="Opacity" icon="mdi:opacity">
					<Tq.InputNumber
						:modelValue="(view?.opacity ?? 1) * 100"
						:min="0"
						:max="100"
						:precision="0"
						suffix="%"
						@update:modelValue="setView({opacity: $event / 100})"
					/>
				</Tq.Parameter>
				<Tq.Parameter label="Scale" icon="mdi:resize">
					<Tq.InputNumber
						:modelValue="transform.scale * 100"
						:min="1"
						:precision="1"
						:step="0.1"
						suffix="%"
						@update:modelValue="setTransform({scale: $event / 100})"
					/>
				</Tq.Parameter>
				<Tq.Parameter label="Position" icon="mdi:cursor-move">
					<Tq.InputVec
						:modelValue="[transform.x, transform.y]"
						:precision="1"
						:step="0.1"
						suffix="%"
						@update:modelValue="setTransform({x: $event[0], y: $event[1]})"
					/>
				</Tq.Parameter>
				<Tq.Parameter label="Rotate" icon="mdi:rotate-right">
					<Tq.InputNumber
						:modelValue="transform.rotate"
						:precision="1"
						:step="0.1"
						suffix="°"
						@update:modelValue="setTransform({rotate: $event})"
					/>
				</Tq.Parameter>
			</Tq.ParameterGrid>
			<div class="foot">
				<Tq.InputButton
					label="Remove from Timeline"
					icon="mdi:table-row-remove"
					subtle
					:disabled="layer === null || layer === project.captureShot.layer"
					@click="removeFromTimeline"
				/>
			</div>
		</div>
	</Tq.Popover>
</template>

<style scoped lang="stylus">
.LayerViewPopover
	width 15rem
	display flex
	flex-direction column
	gap 0.5em

.name
	font-weight bold

.foot
	display flex
	gap var(--tq-gap-control)
	justify-content flex-end
</style>
