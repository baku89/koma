<script setup lang="ts">
import * as Tq from 'tweeq'
import {computed, nextTick, ref, watch} from 'vue'

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
	if (!value) emit('update:index', null)
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
					<Tq.InputString v-model="label" />
				</Tq.Parameter>
				<Tq.Parameter label="Color">
					<Tq.InputColor v-model="color" :alpha="false" />
				</Tq.Parameter>
				<Tq.Parameter label="Duration">
					<Tq.InputNumber v-model="duration" :min="0" :step="1" />
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
