/**
 * Extra SVG overlays on the Preview, from anywhere in the app: a provider
 * returns an SVG fragment (drawn in a 0…1 × 0…1 viewBox stretched over the
 * picture, like `project.viewport.overlay`) or null for nothing. Used by the
 * addsub branch for the distortion-calibration reticle (addsub/distortionReticle.ts).
 */

import {defineStore} from 'pinia'
import {computed, shallowRef} from 'vue'

export type PreviewOverlayProvider = () => string | null

export const usePreviewOverlaysStore = defineStore('previewOverlays', () => {
	const providers = shallowRef<PreviewOverlayProvider[]>([])

	/** Add a provider; returns a function that removes it. */
	function register(fn: PreviewOverlayProvider) {
		providers.value = [...providers.value, fn]
		return () => {
			providers.value = providers.value.filter(p => p !== fn)
		}
	}

	/** The fragments to draw right now. */
	const overlays = computed(() => providers.value.map(p => p()).filter((s): s is string => !!s))

	return {register, overlays}
})
