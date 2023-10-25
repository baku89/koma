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
	const positions: (THREE.Vector3 | null)[] = []

	for (const koma of project.previewKomas) {
		const shot = koma.shots[0]
		const position = shot?.tracker?.position
		if (position) {
			positions.push(new THREE.Vector3(...position))
		} else {
			positions.push(null)
		}
	}

	return positions
})

const realtimePositions = computed(() => {
	const [inPoint, outPoint] = project.previewRange
	const currentFrame = project.captureShot.frame

	if (!tracker.enabled || currentFrame < inPoint || outPoint < currentFrame) {
		return positions.value.filter(isntNil)
	}

	const pos = [...positions.value]
	pos[currentFrame - inPoint] = new THREE.Vector3(...tracker.position)

	return pos.filter(isntNil)
})

function isntNil<T>(value: T): value is NonNullable<T> {
	return value !== null && value !== undefined
}

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
		polylineGeo.computeBoundingSphere()
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
		heightsGeo.computeBoundingSphere()
	},
	{immediate: true}
)

//------------------------------------------------------------------------------
// Orientations

// const orientationsGeo = new THREE.BufferGeometry()
// const orientations = new THREE.LineSegments(
// 	orientationsGeo,
// 	new THREE.LineBasicMaterial({color: 0x00ffff})
// )
// watch(
// 	() => [realtimePositions.value, tracker.groundLevel] as const,
// 	([realtimePositions, groundLevel]) => {
// 		const points = realtimePositions.flatMap(p => [
// 			p,
// 			new THREE.Vector3(p.x, groundLevel, p.z),
// 		])
// 		heightsGeo.setFromPoints(points)
// 		heightsGeo.computeBoundingSphere()
// 	},
// 	{immediate: true}
// )
//
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
