<script setup lang="ts">
/**
 * Layers dialog. Top: the display presets (which layers are shown, in what
 * order, with what blend/opacity) — saved with the project and switchable.
 * Below: every layer (a named timeline sharing the film's frame numbers),
 * its visibility and order in the active preset, and adding new ones. Storage
 * slots never move; only the presets do — so deleting a layer hides it for
 * good without touching its shots, and it can be restored at the bottom.
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

function shotCount(index: number) {
	let shots = 0
	for (const koma of project.komas) if (koma?.shots[index]) shots++
	return shots
}

const rows = computed(() => {
	const stack = project.layerStack
	return project.layers.flatMap((layer, index) => {
		if (layer.deleted) return []
		const pos = stack.findIndex(v => v.layerId === layer.id)
		const visible = pos !== -1 && !stack[pos].hidden
		return [{index, layer, visible, pos, view: project.layerView(index), shots: shotCount(index)}]
	})
})

/**
 * Top of the list first (the preset's order, reversed). Showing or hiding a
 * layer does not move its row: hidden layers keep their place.
 */
const sorted = computed(() => [...rows.value].sort((a, b) => b.pos - a.pos || a.index - b.index))

const deleted = computed(() =>
	project.layers.flatMap((layer, index) =>
		layer.deleted ? [{index, layer, shots: shotCount(index)}] : []
	)
)

function remove(index: number) {
	project.deleteLayer(index)
	// The capture slot moved to the film with it; follow with the selection.
	if (viewport.currentLayer === index) viewport.setCurrentLayer(0)
}

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
						:disabled="row.pos === -1 || row.pos === project.layerStack.length - 1"
						@click="project.moveLayer(row.index, 1)"
					/>
					<Tq.InputButton
						icon="mdi:chevron-down"
						narrow
						subtle
						tooltip="Move down"
						:disabled="row.pos <= 0"
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
				<Tq.InputButton
					icon="mdi:delete-outline"
					narrow
					subtle
					:tooltip="
						row.index === 0
							? 'The film layer can\'t be deleted'
							: 'Delete layer (its shots are kept; restore it below)'
					"
					:disabled="row.index === 0"
					@click="remove(row.index)"
				/>
			</template>
		</div>

		<div v-if="deleted.length > 0" class="deleted">
			<span class="label">Deleted</span>
			<div v-for="d in deleted" :key="d.layer.id" class="deleted-row">
				<span class="name">{{ d.layer.name }}</span>
				<span class="mono">slot {{ d.index }} · {{ d.shots }} shots</span>
				<Tq.InputButton
					label="Restore"
					icon="mdi:restore"
					subtle
					@click="project.restoreLayer(d.index)"
				/>
			</div>
		</div>

		<div class="add">
			<Tq.InputString v-model="newName" placeholder="New layer name" @confirm="add" />
			<Tq.InputButton label="Add Layer" icon="mdi:plus" :disabled="!newName.trim()" @click="add" />
		</div>
		<p class="hint">
			Layers are separate timelines sharing the film's frame numbers — a test
			shot, a replay pass, park references. Presets decide which are shown,
			stacked bottom → top with their blend and opacity. Hidden layers keep
			their shots and their place in the list. A deleted layer leaves every
			preset and the exhibition screens; its shots and files stay, and it
			can be restored.
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
	grid-template-columns auto 1fr 7.5em 5em auto auto auto auto auto
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

.deleted
	display flex
	flex-direction column
	gap var(--tq-gap-group)

.deleted-row
	display flex
	align-items center
	gap var(--tq-gap-control)

	.name
		flex 1 1 0
		color var(--tq-color-text-mute)
		text-decoration line-through

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
