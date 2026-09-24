<script setup lang="ts">
/** One node of screen B's split tree: a row/col of children, or a pane. */
import Pane from './Pane.vue'

export type LayoutNode =
	| {split: 'row' | 'col'; ratio: number; children: LayoutNode[]}
	| {pane: PaneKind; ratio: number}

export type PaneKind = 'meta' | 'sequence' | 'gcode' | 'scene' | 'live' | 'qr'

defineProps<{node: LayoutNode}>()
</script>

<template>
	<div
		class="SplitNode"
		:class="'split' in node ? node.split : 'leaf'"
		:style="{flex: node.ratio}"
	>
		<template v-if="'children' in node">
			<SplitNode v-for="(child, i) in node.children" :key="i" :node="child" />
		</template>
		<Pane v-else :kind="node.pane" />
	</div>
</template>

<style scoped>
.SplitNode {
	display: flex;
	min-width: 0;
	min-height: 0;
	flex-basis: 0;
}

.SplitNode.row {
	flex-direction: row;
}

.SplitNode.col {
	flex-direction: column;
}

.SplitNode.leaf {
	display: block;
}
</style>
