<script lang="ts" setup>
import Tq, {useTweeq} from 'tweeq'
import {ref} from 'vue'

const title = ref('Untitled')
const zoom = ref(0.6)

useTweeq('com.baku89.koma', {colorMode: 'dark'})
</script>

<template>
	<div class="App">
		<Tq.CommandPalette />
		<Tq.TitleBar name="Koma" class="title" icon="favicon.svg">
			<template #left>
				{{ title }}
			</template>
			<template #right>
				<button class="zoom">
					{{ (zoom * 100).toFixed(0) + '%' }}
				</button>
			</template>
		</Tq.TitleBar>
	</div>
</template>

<style lang="stylus" scoped></style>
