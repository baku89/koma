<script setup lang="ts">
/**
 * Layers dialog. Top: the display presets (which layers are shown, in what
 * order, with what blend/opacity) — saved with the project and switchable.
 * Below: every layer (a named timeline sharing the film's frame numbers),
 * its visibility and order in the active preset, and adding new ones. Storage
 * slots never move; only the presets do.
 */
import {useTweeq} from 'tweeq'
import {computed, ref} from 'vue'

import {MixBlendModeValues, useProjectStore} from '@/stores/project'
import {useViewportStore} from '@/stores/viewport'

const Tq = useTweeq()
const project = useProjectStore()
const viewport = useViewportStore()

const newName = ref('')

const presetOptions = computed(() => project.layerPresets.map(p => p.id))
const presetLabels = computed(() => project.layerPresets.map(p => p.name))

const activePresetId = computed({
	get: () => project.activeLayerPreset,
	set: id => project.setActivePreset(id),
})

async function addPreset() {
	const result = await Tq.modal.prompt(
		{name: `${project.activePreset.name} copy`},
		{name: {type: 'string'}},
		{title: 'New Preset (copy of the current one)'}
	)
	if (!result || !result.name.trim()) return
	project.addPreset(result.name.trim())
}

async function renamePreset() {
	const result = await Tq.modal.prompt(
		{name: project.activePreset.name},
		{name: {type: 'string'}},
		{title: 'Rename Preset'}
	)
	if (!result || !result.name.trim()) return
	project.activePreset.name = result.name.trim()
}

function removePreset() {
	project.removePreset(project.activeLayerPreset)
}

const rows = computed(() => {
	const views = project.activePreset.layers
	return project.layers.map((layer, index) => {
		const pos = views.findIndex(v => v.layerId === layer.id)
		let shots = 0
		for (const koma of project.komas) if (koma?.shots[index]) shots++
		return {index, layer, visible: pos !== -1, pos, view: project.layerView(index), shots}
	})
})

/** Top of the stack first (display order reversed), then hidden layers. */
const sorted = computed(() =>
	[...rows.value].sort((a, b) => {
		if (a.visible !== b.visible) return a.visible ? -1 : 1
		return a.visible ? b.pos - a.pos : a.index - b.index
	})
)

function add() {
	const name = newName.value.trim()
	if (!name) return
	project.addLayer(name)
	newName.value = ''
}

function setCapture(index: number) {
	project.$patch({captureShot: {frame: project.captureShot.frame, layer: index}})
	viewport.setCurrentLayer(index)
}
</script>

<template>
	<div class="LayersPanel">
		<div class="presets">
			<span class="label">Preset</span>
			<Tq.InputDropdown v-model="activePresetId" :options="presetOptions" :labels="presetLabels" />
			<Tq.InputButton icon="mdi:plus" narrow tooltip="New preset (copy)" @click="addPreset" />
			<Tq.InputButton icon="mdi:rename" narrow subtle tooltip="Rename preset" @click="renamePreset" />
			<Tq.InputButton
				icon="mdi:delete-outline"
				narrow
				subtle
				tooltip="Delete preset"
				:disabled="project.layerPresets.length <= 1"
				@click="removePreset"
			/>
		</div>

		<div class="grid">
			<div class="head">Show</div>
			<div class="head">Name</div>
			<div class="head">Blend</div>
			<div class="head">Opacity</div>
			<div class="head">Slot</div>
			<div class="head">Shots</div>
			<div class="head">Order</div>
			<div class="head"></div>
			<template v-for="row in sorted" :key="row.layer.id">
				<Tq.InputCheckbox
					:modelValue="row.visible"
					@update:modelValue="project.setLayerVisible(row.index, $event)"
				/>
				<Tq.InputString
					:modelValue="row.layer.name"
					@update:modelValue="project.layers[row.index].name = $event"
				/>
				<Tq.InputDropdown
					:modelValue="row.view.mixBlendMode"
					:options="MixBlendModeValues"
					:disabled="!row.visible"
					@update:modelValue="project.setLayerView(row.index, {mixBlendMode: $event})"
				/>
				<Tq.InputNumber
					:modelValue="row.view.opacity * 100"
					:min="0"
					:max="100"
					:precision="0"
					suffix="%"
					:disabled="!row.visible"
					@update:modelValue="project.setLayerView(row.index, {opacity: $event / 100})"
				/>
				<span class="mono">{{ row.index }}</span>
				<span class="mono">{{ row.shots }}</span>
				<span class="order">
					<Tq.InputButton
						icon="mdi:chevron-up"
						narrow
						subtle
						tooltip="Move up (towards the top of the stack)"
						:disabled="!row.visible || row.pos === project.activePreset.layers.length - 1"
						@click="project.moveLayer(row.index, 1)"
					/>
					<Tq.InputButton
						icon="mdi:chevron-down"
						narrow
						subtle
						tooltip="Move down"
						:disabled="!row.visible || row.pos === 0"
						@click="project.moveLayer(row.index, -1)"
					/>
				</span>
				<Tq.InputButton
					:icon="
						project.captureShot.layer === row.index
							? 'material-symbols:photo-camera'
							: 'material-symbols:photo-camera-outline'
					"
					narrow
					subtle
					tooltip="Shoot into this layer"
					@click="setCapture(row.index)"
				/>
			</template>
		</div>

		<div class="add">
			<Tq.InputString v-model="newName" placeholder="New layer name" @confirm="add" />
			<Tq.InputButton label="Add Layer" icon="mdi:plus" :disabled="!newName.trim()" @click="add" />
		</div>
		<p class="hint">
			Layers are separate timelines sharing the film's frame numbers — a test
			shot, a replay pass, park references. Presets decide which are shown,
			stacked bottom → top with their blend and opacity. Hidden layers keep
			their shots.
		</p>
	</div>
</template>

<style lang="stylus" scoped>
.LayersPanel
	display flex
	flex-direction column
	gap var(--tq-gap-section)
	min-width 44em

.presets
	display flex
	align-items center
	gap var(--tq-gap-control)

	> .TqInputDropdown
		flex 1 1 0

.label
	color var(--tq-color-text-mute)
	font-size 0.85em

.grid
	display grid
	grid-template-columns auto 1fr 7.5em 5em auto auto auto auto
	align-items center
	gap var(--tq-gap-group) var(--tq-gap-control)

.head
	font-size 0.75em
	letter-spacing 0.05em
	text-transform uppercase
	color var(--tq-color-text-mute)

.mono
	font-variant-numeric tabular-nums
	text-align right
	color var(--tq-color-text-mute)

.order
	display flex

.add
	display flex
	gap var(--tq-gap-control)

	> :first-child
		flex 1 1 0

.hint
	margin 0
	font-size 0.85em
	color var(--tq-color-text-mute)
</style>
