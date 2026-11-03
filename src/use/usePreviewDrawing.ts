import {useEventListener} from '@vueuse/core'
import {vec2} from 'linearly'
import {computed, Ref, ref, shallowRef} from 'vue'

import {useProjectStore} from '@/stores/project'
import {useTimelineStore} from '@/stores/timeline'
import {
	eraserHitsStroke,
	extendStrokePath,
	startStrokePath,
	strokePathPoints,
} from '@/utils/previewDrawing'

/** Pixels on screen, so they feel the same at any zoom. */
const MIN_DISTANCE = 2
const ERASER_TOLERANCE = 4

/**
 * Pencil / Eraser over the preview. Nothing touches the project until the
 * pointer is released, so a stroke is one write and one undo step, and an eraser
 * drag that hit nothing leaves no undo step at all.
 *
 * The moves are listened to on window because useZUI takes the pointer capture
 * on the preview when the left button goes down.
 */
export function usePreviewDrawing($frame: Ref<HTMLElement | null>) {
	const project = useProjectStore()
	const timeline = useTimelineStore()

	const tool = computed(() =>
		timeline.currentTool === 'pencil' || timeline.currentTool === 'eraser'
			? timeline.currentTool
			: null
	)

	const liveStroke = ref<string | null>(null)
	const erased = shallowRef(new Set<number>())

	let erasable: vec2[][] | null = null
	let last: vec2 | null = null

	const strokes = computed(() =>
		(project.viewport.drawing ?? []).filter((_, i) => !erased.value.has(i))
	)

	function framePoint(e: PointerEvent): {point: vec2; pixel: number} {
		const rect = $frame.value!.getBoundingClientRect()
		const [width, height] = project.resolution
		return {
			point: [
				((e.clientX - rect.left) / rect.width) * width,
				((e.clientY - rect.top) / rect.height) * height,
			],
			pixel: width / rect.width,
		}
	}

	function erase(from: vec2, to: vec2, pixel: number) {
		if (!erasable) return

		const hits = erasable.flatMap((points, i) =>
			!erased.value.has(i) &&
			eraserHitsStroke(points, from, to, ERASER_TOLERANCE * pixel)
				? [i]
				: []
		)
		if (hits.length > 0) erased.value = new Set([...erased.value, ...hits])
	}

	function onPointerDown(e: PointerEvent) {
		if (e.button !== 0 || !$frame.value) return

		const {point, pixel} = framePoint(e)
		last = point

		if (tool.value === 'pencil') {
			liveStroke.value = startStrokePath(point)
		} else if (tool.value === 'eraser') {
			erasable = (project.viewport.drawing ?? []).map(s =>
				strokePathPoints(s.d)
			)
			erase(point, point, pixel)
		}
	}

	useEventListener(window, 'pointermove', (e: PointerEvent) => {
		if (!last || !$frame.value) return

		const {point, pixel} = framePoint(e)
		if (vec2.distance(point, last) < MIN_DISTANCE * pixel) return

		if (liveStroke.value !== null) {
			liveStroke.value = extendStrokePath(liveStroke.value, point)
		} else {
			erase(last, point, pixel)
		}
		last = point
	})

	function finish() {
		if (!last) return
		last = null

		if (liveStroke.value !== null) {
			project.viewport.drawing = [
				...(project.viewport.drawing ?? []),
				{color: timeline.toolOptions.color, d: liveStroke.value},
			]
			liveStroke.value = null
		} else {
			if (erased.value.size > 0) project.viewport.drawing = strokes.value
			erased.value = new Set()
			erasable = null
		}
	}

	useEventListener(window, 'pointerup', finish)
	useEventListener(window, 'pointercancel', finish)

	return {tool, strokes, liveStroke, onPointerDown}
}
