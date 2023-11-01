<script setup lang="ts">
import {vec3} from 'linearly'
import * as THREE from 'three'
import {BasicMaterial, Group, Sphere} from 'troisjs'
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
	group.add(orientations)
	group.add(targetPolyline)
})

const trackers = computed(() => {
	const [inPoint, outPoint] = project.previewRange
	const currentFrame = project.captureShot.frame

	const trackers = project.previewKomas.map(
		koma => koma.shots[0]?.tracker ?? null
	)

	if (tracker.enabled || inPoint <= currentFrame || currentFrame <= outPoint) {
		trackers[currentFrame - inPoint] = {
			position: tracker.position,
			rotation: tracker.rotation,
		}
	}

	return trackers.filter(isntNil)
})

const positions = computed(() => {
	return trackers.value.map(d => new THREE.Vector3(...d.position))
})

//------------------------------------------------------------------------------
// Trajectory

const polylineGeo = new THREE.BufferGeometry()
const polyline = new THREE.Line(
	polylineGeo,
	new THREE.LineBasicMaterial({color: 0xffffff})
)

watch(
	positions,
	positions => {
		polylineGeo.setFromPoints(positions)
		polylineGeo.computeBoundingSphere()
	},
	{immediate: true}
)

//------------------------------------------------------------------------------
// Heights

const heightsGeo = new THREE.BufferGeometry()
const heights = new THREE.LineSegments(
	heightsGeo,
	new THREE.LineBasicMaterial({color: 0x66ff66})
)

watch(
	() => [positions.value, tracker.groundLevel] as const,
	([positions, groundLevel]) => {
		const points = positions.flatMap(p => [
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

const orientationsGeo = new THREE.BufferGeometry()
const orientations = new THREE.LineSegments(
	orientationsGeo,
	new THREE.LineBasicMaterial({color: 0x6666ff})
)

watch(
	trackers,
	trackers => {
		const points = trackers.flatMap((t, i) => {
			return [
				positions.value[i],
				new THREE.Vector3(
					...vec3.add(t.position, vec3.transformQuat([0, 0, 1], t.rotation))
				),
				new THREE.Vector3(
					...vec3.add(t.position, vec3.transformQuat([-0.08, 0, 0], t.rotation))
				),
				new THREE.Vector3(
					...vec3.add(t.position, vec3.transformQuat([0.08, 0, 0], t.rotation))
				),
			]
		})
		orientationsGeo.setFromPoints(points)
		orientationsGeo.computeBoundingSphere()
	},
	{immediate: true}
)

//------------------------------------------------------------------------------
// Targets

const targetPositions = computed(() => {
	return project.komas.slice(project.captureShot.frame).flatMap(koma => {
		const position = koma.target?.tracker?.position

		if (position) {
			return [new THREE.Vector3(...position)]
		} else {
			return []
		}
	})
})

const targetPolylineGeo = new THREE.BufferGeometry()
const targetPolyline = new THREE.Line(
	targetPolylineGeo,
	new THREE.LineBasicMaterial({color: 0xff6666})
)

watch(
	targetPositions,
	targetPositions => {
		targetPolylineGeo.setFromPoints(targetPositions)
		targetPolylineGeo.computeBoundingSphere()
	},
	{immediate: true}
)

//------------------------------------------------------------------------------
// Utils

function isntNil<T>(value: T): value is NonNullable<T> {
	return value !== null && value !== undefined
}
</script>

<template>
	<Group ref="$group">
		<Sphere v-for="(p, i) in positions" :key="i" :position="p" :radius="0.01" />
		<Sphere
			v-for="(p, i) in targetPositions"
			:key="i"
			:position="p"
			:radius="0.01"
		>
			<BasicMaterial color="#f66" />
		</Sphere>
		<Sphere
			v-if="tracker.averageTarget && targetPositions.length === 0"
			:position="new THREE.Vector3(...tracker.averageTarget.position)"
			:radius="0.01"
		>
			<BasicMaterial color="#f66" />
		</Sphere>
	</Group>
</template>
