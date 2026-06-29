<script setup lang="ts">
import * as Tq from 'tweeq'
import {computed, nextTick, onUnmounted, ref, watch} from 'vue'

import {useProjectStore} from '@/stores/project'

const props = defineProps<{
	// Index of the marker being edited, or null when the popover is closed.
	index: number | null
	// The marker element the popover anchors to.
	reference: HTMLElement | null
}>()

const emit = defineEmits<{
	'update:index': [number | null]
}>()

const project = useProjectStore()

const open = computed(() => props.index !== null)

const marker = computed(() =>
	props.index !== null ? project.markers[props.index] : undefined
)

function patch<K extends 'label' | 'color' | 'duration'>(
	key: K,
	value: (typeof project.markers)[number][K]
) {
	const index = props.index
	if (index === null) return
	// Lazily open the interaction on the first real write (mirrors the marker
	// drag in TimelineMarkers), so merely opening the popover and auto-focusing
	// the label doesn't fire a save or a no-op undo entry.
	beginEdit()
	project.$patch(draft => {
		draft.markers[index][key] = value
	})
}

const label = computed({
	get: () => marker.value?.label ?? '',
	set: v => patch('label', v),
})

const color = computed({
	get: () => marker.value?.color ?? '#ffffff',
	set: v => patch('color', v),
})

const duration = computed({
	get: () => marker.value?.duration ?? 0,
	set: v => patch('duration', v),
})

// Each field write goes to the undoable `markers`, so without bracketing every
// tweak (a duration drag, each keystroke) would fire autosave + a history entry.
// Bracket an edit as a single interaction: begin lazily on the first write, end
// on `confirm` — it suspends autosave/history during the gesture and commits
// exactly one save + one undo step on commit. `confirm` is the complete "edit
// committed" signal across every input (Enter, drag end, and blur all emit it;
// the color pad emits *only* confirm, no blur), so we don't also listen to blur.
// The guard keeps begin/end paired across repeated commits and field switches.
let interacting = false

function beginEdit() {
	if (interacting) return
	interacting = true
	project.beginInteraction()
}

function endEdit() {
	if (!interacting) return
	interacting = false
	project.endInteraction()
}

// If the popover closes mid-edit (light-dismiss, unmount), flush the interaction
// so the suspend depth never leaks.
onUnmounted(endEdit)

// A zero-duration marker collapses to a dot and is shifted left by half its
// height (margin-left: -0.5em) so the dot centers on its frame. That moves the
// reference's left edge — which bottom-start anchors to — so the balloon would
// jump by 0.5em as duration crosses 0↔1. Cancel it out with a cross-axis offset.
const offset = computed(() => {
	const isDot = marker.value?.duration === 0
	const halfHeight = (props.reference?.offsetHeight ?? 0) / 2
	return {mainAxis: 0, crossAxis: isDot ? halfHeight : 0}
})

const $grid = ref<HTMLElement | null>(null)

// Focus (and select) the label field when the popover opens, so a double-click
// drops you straight into renaming — matching the old window.prompt flow.
watch(open, async isOpen => {
	if (!isOpen) return
	await nextTick()
	const input = $grid.value?.querySelector('input')
	if (input) {
		input.focus()
		input.select()
	}
})

function onUpdateOpen(value: boolean) {
	if (!value) {
		endEdit()
		emit('update:index', null)
	}
}
</script>

<template>
	<Tq.Popover
		:reference="reference"
		:open="open"
		placement="bottom-start"
		:offset="offset"
		arrow
		exit-transition
		@update:open="onUpdateOpen"
	>
		<div ref="$grid" class="MarkerEditPopover">
			<Tq.ParameterGrid>
				<Tq.Parameter label="Label">
					<Tq.InputString v-model="label" @confirm="endEdit" />
				</Tq.Parameter>
				<Tq.Parameter label="Color">
					<Tq.InputColor
						v-model="color"
						:alpha="false"
						@confirm="endEdit"
					/>
				</Tq.Parameter>
				<Tq.Parameter label="Duration">
					<Tq.InputNumber
						v-model="duration"
						:min="0"
						:step="1"
						suffix="F"
						@confirm="endEdit"
					/>
				</Tq.Parameter>
			</Tq.ParameterGrid>
		</div>
	</Tq.Popover>
</template>

<style lang="stylus" scoped>
@import '../../../dev_modules/tweeq/src/common.styl'

.MarkerEditPopover
	min-width 14em
</style>
