import {Bndr} from 'bndr-js'
import {defineStore} from 'pinia'
import {useActionsStore} from 'tweeq'

interface SelectionOptions {
	context: string
	onDelete?: () => void
	onUnselect?: () => void
	onCopy?: () => void
	onCut?: () => void
	onPaste?: () => void
}

export const useSelectionStore = defineStore('selection', () => {
	const actions = useActionsStore()

	let selection: SelectionOptions | null = null
	let willUnselect = true

	function select(options: SelectionOptions) {
		willUnselect = false
		setTimeout(() => {
			willUnselect = true
		})
		if (
			selection &&
			options.context !== selection.context &&
			selection.onUnselect
		) {
			selection.onUnselect()
		}
		selection = options
	}

	function unselect() {
		if (selection?.onUnselect) selection.onUnselect()
		selection = null
	}

	function cut() {
		if (selection?.onCut) selection.onCut()
	}

	function copy() {
		if (selection?.onCopy) selection.onCopy()
	}

	function paste() {
		if (selection?.onPaste) selection.onPaste()
	}

	function reserveUnselect() {
		if (!willUnselect) return

		willUnselect = true

		setTimeout(() => willUnselect && unselect())
	}

	actions.register([
		{
			id: 'delete_selected',
			icon: 'mdi:backspace',
			input: [
				'delete',
				'backspace',
				Bndr.gamepad().button('+').longPress(500).pressed,
			],
			perform() {
				if (selection?.onDelete) {
					selection.onDelete()
				}
			},
		},
		{
			id: 'unselect',
			icon: 'mdi:close',
			input: 'esc',
			perform: unselect,
		},
		{
			id: 'cut',
			icon: 'mdi:content-cut',
			input: 'command+x',
			perform: cut,
		},
		{
			id: 'copy',
			icon: 'mdi:content-copy',
			input: 'command+c',
			perform: copy,
		},
		{
			id: 'paste',
			icon: 'mdi:content-paste',
			input: 'command+v',
			perform: paste,
		},
	])

	return {select, unselect, reserveUnselect}
})
