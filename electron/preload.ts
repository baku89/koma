/**
 * The renderer-facing bridge (`window.koma`). Kept tiny: paths and a few
 * shell calls. Everything else koma does through web APIs as in the browser.
 * Typed for the renderer in `src/electron.ts`.
 */
import {contextBridge, ipcRenderer} from 'electron'

contextBridge.exposeInMainWorld('koma', {
	platform: process.platform,
	versions: {electron: process.versions.electron, chrome: process.versions.chrome},
	/** Finder (or the platform's file manager) with `path` selected. */
	revealInFinder: (p: string) => ipcRenderer.invoke('koma:reveal', p),
	/** Open a file or folder with its default app (a folder opens in Finder). */
	openPath: (p: string) => ipcRenderer.invoke('koma:open-path', p),
	/** Byte-free move inside a granted folder; creates the target's folder. */
	rename: (from: string, to: string) => ipcRenderer.invoke('koma:rename', from, to),
	/**
	 * The real path of the most recent directory the page was granted access
	 * to (File System Access API) whose name is `name`, or null.
	 */
	grantedDirectoryPath: (name: string): Promise<string | null> =>
		ipcRenderer.invoke('koma:granted-dir', name),
	/** Menu items that run one of the app's commands by id. */
	onCommand: (cb: (id: string) => void) => {
		ipcRenderer.on('koma:command', (_e, id: string) => cb(id))
	},
	/** The built-in aux helper (ptpcamera killer, OSC bridge). */
	auxStatus: () => ipcRenderer.invoke('koma:aux-status'),
})
