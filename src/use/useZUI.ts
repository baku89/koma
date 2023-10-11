import {Bndr} from 'bndr-js'
import {mat2d, vec2} from 'linearly'
import {Mat2d} from 'linearly'
import {useBndr} from 'tweeq'
import {Ref} from 'vue'

export function useZUI(
	element: Ref<HTMLElement | null>,
	onTransform: (delta: Mat2d) => void
) {
	useBndr(element, element => {
		const pointer = Bndr.pointer(element)
		const keyboard = Bndr.keyboard()

		const lmbPressed = pointer.left.pressed({pointerCapture: true})
		const mmbPressed = pointer.middle.pressed({pointerCapture: true})
		const position = pointer.position()
		const scroll = pointer.scroll({preventDefault: true})

		const altPressed = keyboard.pressed('alt')

		// Pan
		const panByDrag = position.while(mmbPressed).delta(vec2.delta)
		const panByScroll = scroll.map(vec2.negate).while(altPressed.not, false)

		Bndr.combine(panByDrag, panByScroll)
			.map(mat2d.fromTranslation)
			.on(onTransform)

		// Zoom
		const zoomOrigin = position.stash(
			Bndr.combine(lmbPressed.down(), scroll.constant(true as const))
		)

		const zoomByScroll = scroll.while(altPressed, false).map(([, y]) => y)

		Bndr.combine(zoomByScroll)
			.map(delta =>
				mat2d.fromScaling(vec2.of(1.003 ** delta), zoomOrigin.value)
			)
			.on(onTransform)
	})
}
