<script setup lang="ts">
import * as THREE from 'three'
import {Group, Sphere} from 'troisjs'
import {computed, onMounted, ref, watch} from 'vue'

import {useProjectStore} from '@/stores/project'
import {useTrackerStore} from '@/stores/tracker'

const $group = ref<any>()

const project = useProjectStore()
const tracker = useTrackerStore()

onMounted(() => {
	const group: THREE.Group = $group.value
	if (!group) return

	group.add(polyline)
	group.add(heights)
})

const positions = computed(() => {
	const [inPoint, outPoint] = project.previewRange
	const slicedKoma = project.allKomas.slice(inPoint, outPoint)

	return slicedKoma.flatMap(koma => {
		const shot = koma.shots[0]
		const position = shot?.tracker?.position ?? null
		return position ? new THREE.Vector3(...position) : []
	})
})

const realtimePositions = computed(() => {
	const [inPoint, outPoint] = project.previewRange
	const currentFrame = project.captureShot.frame

	if (currentFrame < inPoint || outPoint < currentFrame) {
		return positions.value
	}

	const pos = [...positions.value]
	pos[currentFrame - inPoint] = new THREE.Vector3(...tracker.position)

	return pos
})

//------------------------------------------------------------------------------
// Trajectory

const polylineGeo = new THREE.BufferGeometry()
const polyline = new THREE.Line(
	polylineGeo,
	new THREE.LineBasicMaterial({color: 0xffffff})
)

watch(
	realtimePositions,
	realtimePositions => {
		polylineGeo.setFromPoints(realtimePositions)
	},
	{immediate: true}
)

//------------------------------------------------------------------------------
// Heights

const heightsGeo = new THREE.BufferGeometry()
const heights = new THREE.LineSegments(
	heightsGeo,
	new THREE.LineBasicMaterial({color: 0x00ffff})
)

watch(
	() => [realtimePositions.value, tracker.groundLevel] as const,
	([realtimePositions, groundLevel]) => {
		const points = realtimePositions.flatMap(p => [
			p,
			new THREE.Vector3(p.x, groundLevel, p.z),
		])
		heightsGeo.setFromPoints(points)
	},
	{immediate: true}
)
</script>

<template>
	<Group ref="$group">
		<Sphere
			v-for="(p, i) in realtimePositions"
			:key="i"
			:position="p"
			:radius="0.01"
		/>
	</Group>
</template>
