/**
 * Electron main process for koma.
 *
 * What the desktop build adds over the PWA:
 * - WebUSB / WebSerial without Chrome's pickers (`devices.ts`): serial ports
 *   are all granted (koma identifies them itself), cameras are picked once
 *   and remembered.
 * - The real path of every project folder the renderer gets access to, so
 *   renames (re-sequencing shots) are `fs.rename` instead of copy + delete,
 *   and "Reveal in Finder" works.
 * - The aux helper (ptpcamera killer + OSC bridge) runs in this process; no
 *   separate `yarn aux`.
 * - Reload / close while a save is in flight asks first (the renderer's
 *   `beforeunload` lands in `will-prevent-unload` here).
 */
import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	net,
	protocol,
	type Rectangle,
	screen,
	session,
	shell,
} from 'electron'
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {copyFile, mkdir, rename, unlink} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

import {auxStatus, startAux} from './aux'
import {grantedDirectoryPath, installDeviceHandlers, isGrantedPath} from './devices'
import {buildMenu} from './menu'

const APP_SCHEME = 'koma'
const APP_HOST = 'app'
const TITLEBAR_HEIGHT = 38 // tweeq's default `--titlebar-area-height`

const here = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url))
// build/electron/main.js → build/renderer
const RENDERER_DIR = path.resolve(here, '../renderer')
const PRELOAD = path.join(here, 'preload.cjs')

// A proper (tuple) origin for the packaged renderer: IndexedDB, the File System
// Access API and persisted directory handles all need one; `file://` would not do.
protocol.registerSchemesAsPrivileged([
	{
		scheme: APP_SCHEME,
		privileges: {
			standard: true,
			secure: true,
			supportFetchAPI: true,
			corsEnabled: true,
			stream: true,
			codeCache: true,
		},
	},
])

// Sounds (shutter, buzzer) without a prior click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// A separate profile (window state, USB grants, IndexedDB) for tests / scratch runs.
if (process.env.KOMA_USER_DATA) app.setPath('userData', path.resolve(process.env.KOMA_USER_DATA))

// This process owns the camera and every serial port; a second copy would
// only fight over them.
if (!app.requestSingleInstanceLock()) {
	app.quit()
}

let win: BrowserWindow | null = null

//------------------------------------------------------------------------------
// Window bounds persistence

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json')

function loadBounds(): Partial<Rectangle> {
	try {
		const b = JSON.parse(readFileSync(stateFile(), 'utf8')) as Rectangle
		// Only reuse bounds that still land on a connected display.
		const visible = screen.getAllDisplays().some(d => {
			const a = d.workArea
			return (
				b.x + b.width > a.x &&
				b.x < a.x + a.width &&
				b.y + b.height > a.y &&
				b.y < a.y + a.height
			)
		})
		return visible ? b : {width: b.width, height: b.height}
	} catch {
		return {}
	}
}

function saveBounds(w: BrowserWindow) {
	try {
		if (w.isFullScreen() || w.isMinimized()) return
		mkdirSync(path.dirname(stateFile()), {recursive: true})
		writeFileSync(stateFile(), JSON.stringify(w.getNormalBounds()))
	} catch {
		// best effort
	}
}

//------------------------------------------------------------------------------

function createWindow() {
	const bounds = loadBounds()
	win = new BrowserWindow({
		width: 1400,
		height: 900,
		...bounds,
		minWidth: 800,
		minHeight: 500,
		title: 'Koma',
		backgroundColor: '#1a1a1a',
		// Window Controls Overlay: the renderer lays its own title bar out with
		// env(titlebar-area-*), exactly as the installed PWA does.
		titleBarStyle: 'hidden',
		titleBarOverlay: {height: TITLEBAR_HEIGHT},
		trafficLightPosition: {x: 12, y: (TITLEBAR_HEIGHT - 12) / 2},
		webPreferences: {
			preload: PRELOAD,
			contextIsolation: true,
			sandbox: true,
			spellcheck: false,
			// The shot sequence, LED chase and settle timers run in this page; a
			// background tab in Chrome throttles them to ~1 Hz. Not here.
			backgroundThrottling: false,
		},
	})

	win.on('close', () => win && saveBounds(win))
	win.on('closed', () => (win = null))

	// The renderer's `beforeunload` (save in flight / unsaved edits) silently
	// cancels reload and close in Electron. Ask instead.
	win.webContents.on('will-prevent-unload', event => {
		if (!win) return
		const choice = dialog.showMessageBoxSync(win, {
			type: 'warning',
			buttons: ['Stay', 'Leave anyway'],
			defaultId: 0,
			cancelId: 0,
			message: 'Koma is still saving, or has unsaved changes.',
			detail:
				'Files may be being renamed in the project folder right now. ' +
				'Leaving mid-way can leave the folder half-renamed.',
		})
		if (choice === 1) event.preventDefault()
	})

	win.webContents.setWindowOpenHandler(({url}) => {
		// Links out of the app (devlog etc.) go to the system browser.
		if (/^https?:/.test(url)) shell.openExternal(url)
		return {action: 'deny'}
	})

	const dev = process.env.VITE_DEV_SERVER_URL
	if (dev) {
		win.loadURL(dev)
	} else {
		win.loadURL(`${APP_SCHEME}://${APP_HOST}/index.html`)
	}
}

function serveRenderer() {
	protocol.handle(APP_SCHEME, request => {
		const url = new URL(request.url)
		let rel = decodeURIComponent(url.pathname)
		if (rel === '/' || rel === '') rel = '/index.html'
		const file = path.join(RENDERER_DIR, path.normalize(rel))
		if (!file.startsWith(RENDERER_DIR) || !existsSync(file)) {
			return new Response('Not found', {status: 404})
		}
		return net.fetch(pathToFileURL(file).toString())
	})
}

//------------------------------------------------------------------------------
// IPC (see preload.ts for the renderer-side shape)

function assertGranted(p: string) {
	if (!isGrantedPath(p)) {
		throw new Error(`Path is outside every folder the renderer was granted: ${p}`)
	}
}

ipcMain.handle('koma:reveal', (_e, p: string) => {
	assertGranted(p)
	shell.showItemInFolder(p)
})

ipcMain.handle('koma:open-path', (_e, p: string) => {
	assertGranted(p)
	return shell.openPath(p)
})

/**
 * Byte-free move of a file inside a granted folder (the File System Access
 * API's `move()` throws for picked folders in Chromium, so koma's re-sequencing
 * falls back to copy + delete there). Creates the target folder.
 */
ipcMain.handle('koma:rename', async (_e, from: string, to: string) => {
	assertGranted(from)
	assertGranted(to)
	await mkdir(path.dirname(to), {recursive: true})
	try {
		await rename(from, to)
	} catch (err) {
		// Across volumes rename() can't; copy and remove.
		if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
		await copyFile(from, to)
		await unlink(from)
	}
})

ipcMain.handle('koma:granted-dir', (_e, name: string) => grantedDirectoryPath(name))

ipcMain.handle('koma:aux-status', () => auxStatus())

//------------------------------------------------------------------------------

app.on('second-instance', () => {
	if (win) {
		if (win.isMinimized()) win.restore()
		win.focus()
	}
})

app.whenReady().then(() => {
	serveRenderer()
	installDeviceHandlers(session.defaultSession, () => win)
	buildMenu(() => win)
	startAux()
	createWindow()

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow()
	})
})

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit()
})
