/**
 * The desktop (Electron) bridge exposed by `electron/preload.ts` as
 * `window.koma`, or undefined in a browser. Everything here is optional:
 * koma works the same without it, minus byte-free renames of project files
 * and "Reveal in Finder".
 */
export interface KomaNative {
	platform: NodeJS.Platform | string
	versions: {electron: string; chrome: string}
	revealInFinder(path: string): Promise<void>
	openPath(path: string): Promise<string>
	rename(from: string, to: string): Promise<void>
	grantedDirectoryPath(name: string): Promise<string | null>
	onCommand(cb: (id: string) => void): void
	auxStatus(): Promise<{ptpKiller: boolean; osc: 'off' | 'open' | 'error'; oscError?: string}>
}

export const native: KomaNative | undefined =
	typeof window === 'undefined' ? undefined : (window as unknown as {koma?: KomaNative}).koma

export const isElectron = native !== undefined
