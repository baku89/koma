import * as Bndr from 'bndr-js'
import {mat2d, vec2} from 'linearly'
import {useBndr} from 'tweeq'
import {Ref} from 'vue'

export function useZUI(
	element: Ref<HTMLElement | null>,
	onTransform: (delta: mat2d) => void
) {
	useBndr(element, element => {
		const pointer = Bndr.pointer(element)
		const keyboard = Bndr.keyboard()

		const lmbPressed = pointer.left.pressed({pointerCapture: true})
		const mmbPressed = pointer.middle.pressed({pointerCapture: true})
		const position = pointer.position()
		const scroll = pointer.scroll({preventDefault: true})

		const altPressed = keyboard.pressed('option')

		// Pan
		const panByDrag = position.while(mmbPressed).delta(vec2.delta)
		const panByScroll = scroll.map(vec2.negate).while(altPressed.not(), false)

		Bndr.combine(panByDrag, panByScroll)
			.map(mat2d.fromTranslation)
			.on(onTransform)

		// Zoom
		const zoomByScroll = scroll.while(altPressed, false).map(([, y]) => y)
		const zoomByPinch = pointer.pinch().map(v => -2 * v)

		const zoomOrigin = position.stash(
			Bndr.combine(
				lmbPressed.down(),
				scroll.constant(true as const),
				zoomByPinch.constant(true as const)
			)
		)

		Bndr.combine(zoomByScroll, zoomByPinch)
			.map(delta =>
				mat2d.fromScaling(vec2.of(1.003 ** delta), zoomOrigin.value)
			)
			.on(onTransform)
	})
}
