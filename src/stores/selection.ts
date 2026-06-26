import * as Bndr from 'bndr-js'
import {defineStore} from 'pinia'
import {useTweeq} from 'tweeq'

interface SelectionOptions {
	context: string
	onDelete?: () => void
	onUnselect?: () => void
	onCopy?: () => void
	onCut?: () => void
	onPaste?: () => void
}

export const useSelectionStore = defineStore('selection', () => {
	const Tq = useTweeq()

	let selection: SelectionOptions | null = null
	// Paste acts on the clipboard, not the live selection. Keep every context's
	// latest paste handler (keyed by context, so at most one per kind) and run
	// them all on paste — each no-ops unless the clipboard holds its kind of
	// data. This lets you cut, click elsewhere (which clears or changes the
	// selection), and paste repeatedly, regardless of what's selected now.
	const pasteHandlers = new Map<string, () => void>()
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
		if (options.onPaste) pasteHandlers.set(options.context, options.onPaste)
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
		for (const onPaste of pasteHandlers.values()) onPaste()
	}

	function reserveUnselect() {
		if (!willUnselect) return

		willUnselect = true

		setTimeout(() => willUnselect && unselect())
	}

	Tq.actions.register([
		{
			id: 'edit',
			children: [
				{
					id: 'copy',
					icon: 'mdi:content-copy',
					bind: 'command+c',
					perform: copy,
				},
				{
					id: 'cut',
					icon: 'mdi:content-cut',
					bind: 'command+x',
					perform: cut,
				},
				{
					id: 'paste',
					icon: 'mdi:content-paste',
					bind: 'command+v',
					perform: paste,
				},
				{
					id: 'delete',
					icon: 'mdi:backspace',
					bind: [
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
					bind: 'esc',
					perform: unselect,
				},
			],
		},
	])

	return {select, unselect, reserveUnselect}
})
