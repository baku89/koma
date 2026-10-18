/**
 * Application menu. Deliberately thin: koma binds its own shortcuts in the
 * page (tweeq actions), and a key the page handles never reaches a menu
 * accelerator — so the Edit roles only serve text fields, and View keeps
 * Reload (guarded by `will-prevent-unload`) and DevTools.
 */
import {app, type BrowserWindow, Menu, type MenuItemConstructorOptions, shell} from 'electron'

export function buildMenu(getWindow: () => BrowserWindow | null) {
	const send = (id: string) => () => getWindow()?.webContents.send('koma:command', id)

	const template: MenuItemConstructorOptions[] = [
		...(process.platform === 'darwin' ? [{role: 'appMenu'} as MenuItemConstructorOptions] : []),
		{
			label: 'File',
			submenu: [
				{label: 'Open Project Folder in Finder', click: send('open_project_folder')},
				{type: 'separator'},
				{role: 'close'},
			],
		},
		{role: 'editMenu'},
		{
			label: 'View',
			submenu: [
				{role: 'reload'},
				{role: 'forceReload'},
				{role: 'toggleDevTools'},
				{type: 'separator'},
				{role: 'togglefullscreen'},
			],
		},
		{role: 'windowMenu'},
		{
			role: 'help',
			submenu: [
				{
					label: 'koma on GitHub',
					click: () => shell.openExternal('https://github.com/baku89/koma'),
				},
			],
		},
	]

	Menu.setApplicationMenu(Menu.buildFromTemplate(template))
	app.setAboutPanelOptions({applicationName: 'Koma'})
}
