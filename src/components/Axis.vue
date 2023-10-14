<script setup lang="ts">
import {Mat4, mat4} from 'linearly'
import {Euler, Quaternion, Vector3} from 'three'
import {BasicMaterial, Box} from 'troisjs'
import {computed} from 'vue'

interface Props {
	matrix: Mat4
}

const props = defineProps<Props>()

const position = computed(() => {
	return new Vector3(...mat4.getTranslation(props.matrix))
})

const rotation = computed(() => {
	const q = mat4.getRotation(props.matrix)
	const quat = new Quaternion(...q)

	const euler = new Euler().setFromQuaternion(quat)
	const [x, y, z] = euler.toArray()
	return {x, y, z}
})
</script>

<template>
	<Group :position="position" :rotation="rotation">
		<Box :scale="{x: 0.2, y: 0.01, z: 0.01}" :position="{x: 0.1}">
			<BasicMaterial color="#ff0000" />
		</Box>
		<Box :scale="{x: 0.01, y: 0.2, z: 0.01}" :position="{y: 0.1}">
			<BasicMaterial color="#00ff00" />
		</Box>
		<Box :scale="{x: 0.01, y: 0.01, z: 0.2}" :position="{z: 0.1}">
			<BasicMaterial color="#0000ff" />
		</Box>
	</Group>
</template>
