<script setup lang="ts">
import {mat4, quat, vec3, vec4} from 'linearly'
import * as Tq from 'tweeq'

import {useAuxDevicesStore} from '@/stores/auxDevices'
import {useOscStore} from '@/stores/osc'

defineProps<{
	label: string
	blink?: boolean
}>()

const emit = defineEmits<{
	record: [matrix: mat4]
}>()

const aux = useAuxDevicesStore()
const osc = useOscStore()

let positions: vec3[] = []
let rotations: quat[] = []

let subscriptionId: number | null = null

function onStartRec() {
	positions = []
	rotations = []

	subscriptionId = osc.osc.on('*', () => {
		positions.push(aux.tracker.position)
		rotations.push(aux.tracker.rotation)
	})
}

function onStopRec() {
	if (subscriptionId !== null) {
		osc.osc.off('*', subscriptionId)
	}

	const averagePosition = vec3.scale(
		positions.reduce((a, b) => vec3.add(a, b), vec3.zero),
		1 / positions.length
	)
	const averageRotation = quat.normalize(
		vec4.scale(
			rotations.reduce((a, b) => vec4.add(a, b), vec4.zero),
			1 / rotations.length
		)
	)

	const matrix = mat4.fromRotationTranslation(averageRotation, averagePosition)

	emit('record', matrix)
}
</script>

<template>
	<Tq.InputButton
		:label="label"
		:blink="blink"
		@pointerdown="onStartRec"
		@pointerup="onStopRec"
	/>
</template>
