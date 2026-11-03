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

import {useProjectStore} from '@/stores/project'
import {useViewportStore} from '@/stores/viewport'

const Tq = useTweeq()
const project = useProjectStore()
const viewport = useViewportStore()

const newName = ref('')

// Names being typed: the folder follows the name only when it is confirmed
// (Enter / blur), so a folder project isn't copied on every keystroke.
const draftNames = ref<Record<string, string>>({})

function commitName(index: number) {
	const layer = project.layers[index]
	const draft = draftNames.value[layer.id]
	delete draftNames.value[layer.id]
	if (draft === undefined) return
	project.renameLayer(index, draft).catch(e => {
		// eslint-disable-next-line no-console
		console.error('[layers] rename failed', e)
		alert(`Could not move the layer's folder: ${(e as Error).message}`)
	})
}

async function migrate() {
	await Tq.actions.perform('migrate_layer_folders')
}

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
		return [{index, layer, visible, pos, shots: shotCount(index)}]
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

/** The list is top of the stack first; the stack is bottom → top. */
function reorder(list: typeof sorted.value) {
	project.setLayerOrder(list.map(row => row.layer.id).reverse())
}

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
			<Tq.InputArray
				:modelValue="sorted"
				:itemKey="row => row.layer.id"
				sortable
				:removable="row => row.index !== 0"
				appendable
				@update:modelValue="reorder"
				@remove="row => remove(row.index)"
			>
				<template #header>
					<Tq.TableHeader :columns="['Show', 'Name', 'Slot', 'Shots', '']" />
				</template>
				<template #default="{item: row}">
					<Tq.InputCheckbox
						:modelValue="row.visible"
						@update:modelValue="project.setLayerVisible(row.index, $event)"
					/>
					<Tq.InputString
						:modelValue="draftNames[row.layer.id] ?? row.layer.name"
						@update:modelValue="draftNames[row.layer.id] = $event"
						@confirm="commitName(row.index)"
						@keydown.enter.stop
					/>
					<span class="mono">{{ row.index }}</span>
					<span class="mono">{{ row.shots }}</span>
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
				<template #add>
					<div class="add">
						<Tq.InputString
							v-model="newName"
							placeholder="New layer name"
							@confirm="add"
							@keydown.enter.stop
						/>
						<Tq.InputButton
							label="Add Layer"
							icon="mdi:plus"
							:disabled="!newName.trim()"
							@click="add"
						/>
					</div>
				</template>
			</Tq.InputArray>
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

		<div v-if="project.assetLayout !== 3" class="migrate">
			<Tq.InputButton
				:label="project.assetLayout === 2 ? 'Rename to project_layer_0001…' : 'Move into layer folders…'"
				icon="mdi:folder-move-outline"
				subtle
				@click="migrate"
			/>
		</div>
	</div>
</template>

<style lang="stylus" scoped>
.LayersPanel
	display flex
	flex-direction column
	gap var(--tq-gap-section)

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
	grid-template-columns auto minmax(8em, 1fr) auto auto auto
	align-items center
	column-gap var(--tq-gap-control)

.mono
	font-variant-numeric tabular-nums
	text-align right
	color var(--tq-color-text-mute)

.migrate
	display flex
	justify-content flex-end

.deleted
	display flex
	flex-direction column
	gap var(--tq-gap-control)

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

</style>
