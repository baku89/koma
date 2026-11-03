/**
 * The desktop (Electron) bridge exposed by `electron/preload.ts` as
 * `window.koma`, or undefined in a browser. Everything here is optional:
 * koma works the same without it, minus byte-free renames of project files
 * and "Reveal in Finder".
 */
import type {AuxStatus} from '../dev_modules/aux-manager/lib/aux.js'

export interface KomaNative {
	platform: NodeJS.Platform | string
	versions: {electron: string; chrome: string}
	revealInFinder(path: string): Promise<void>
	openPath(path: string): Promise<string>
	rename(from: string, to: string): Promise<void>
	grantedDirectoryPath(name: string): Promise<string | null>
	onCommand(cb: (id: string) => void): void
	/** The bundled aux helper (electron/aux.ts): ptpcamera killer, OSC bridge, tools bridge. */
	auxStatus(): Promise<AuxStatus | null>
	/** The real path of a dropped / picked File ('' when unknown). */
	pathForFile(file: File): string
}


export const native: KomaNative | undefined =
	typeof window === 'undefined' ? undefined : (window as unknown as {koma?: KomaNative}).koma

export const isElectron = native !== undefined
