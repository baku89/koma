<script setup lang="ts">
import {useAuxStore} from '@/stores/aux'
import {useOscStore} from '@/stores/osc'

const aux = useAuxStore()
const osc = useOscStore()
</script>

<template>
	<div class="CameraTrajectoryVisualizer">
		OSC Connected = {{ osc.connected }} <br />
		<br />
		Tracker Enabled = {{ aux.tracker.enabled }} <br />
		Position = {{ aux.tracker.position }} <br />
		Rotation = {{ aux.tracker.rotation }}
	</div>
</template>
