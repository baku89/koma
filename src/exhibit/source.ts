/**
 * Where the exhibition screens read the project from. Two backends behind
 * one read-only interface:
 *
 * - `HttpSource`: the display copy served by koma-relay (`/project/…`). The
 *   normal case — the kiosk browser opens the page from the relay itself, so
 *   nothing has to be picked or granted after a reboot. Change detection is
 *   a conditional GET (ETag), so polling costs one 304 per file.
 * - `DirSource`: a folder through the File System Access API (a picked
 *   folder synced by other means, or an OPFS folder for tests). Kept as the
 *   fallback when no relay is around.
 */

export type TextResult = {text: string; version: string} | 'unchanged' | null

export interface ProjectSource {
	kind: 'http' | 'dir'
	/** Shown in the setup overlay. */
	label: string
	/**
	 * Read a text file. With `ifNotVersion`, returns 'unchanged' when the
	 * file still has that version. Null = missing.
	 */
	text(rel: string, ifNotVersion?: string | null): Promise<TextResult>
	/** Read a binary file, detached from its storage. Null = missing. */
	blob(rel: string): Promise<Blob | null>
}

//------------------------------------------------------------------------------

export class HttpSource implements ProjectSource {
	readonly kind = 'http' as const
	readonly label: string
	readonly #base: string

	/** @param base URL of the project copy, e.g. `http://host:7777/project/` */
	constructor(base: string) {
		this.#base = base.endsWith('/') ? base : base + '/'
		this.label = this.#base
	}

	#url(rel: string) {
		return new URL(rel.split('/').map(encodeURIComponent).join('/'), this.#base).toString()
	}

	async text(rel: string, ifNotVersion?: string | null): Promise<TextResult> {
		const headers: Record<string, string> = {}
		if (ifNotVersion) headers['If-None-Match'] = ifNotVersion
		const res = await fetch(this.#url(rel), {headers, cache: 'no-store'})
		if (res.status === 304) return 'unchanged'
		if (res.status === 404) return null
		if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`)
		const text = await res.text()
		const version = res.headers.get('ETag') ?? String(Date.now())
		if (ifNotVersion && version === ifNotVersion) return 'unchanged'
		return {text, version}
	}

	async blob(rel: string): Promise<Blob | null> {
		const res = await fetch(this.#url(rel), {cache: 'no-store'})
		if (!res.ok) return null
		return res.blob()
	}
}

//------------------------------------------------------------------------------

export class DirSource implements ProjectSource {
	readonly kind = 'dir' as const
	readonly label: string
	readonly handle: FileSystemDirectoryHandle

	constructor(handle: FileSystemDirectoryHandle) {
		this.handle = handle
		this.label = handle.name
	}

	async #file(rel: string): Promise<File | null> {
		try {
			const parts = rel.split('/').filter(Boolean)
			let d = this.handle
			for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part)
			const fh = await d.getFileHandle(parts[parts.length - 1])
			return await fh.getFile()
		} catch {
			return null
		}
	}

	async text(rel: string, ifNotVersion?: string | null): Promise<TextResult> {
		const f = await this.#file(rel)
		if (!f) return null
		const version = String(f.lastModified)
		if (ifNotVersion && version === ifNotVersion) return 'unchanged'
		return {text: await f.text(), version}
	}

	async blob(rel: string): Promise<Blob | null> {
		const f = await this.#file(rel)
		if (!f) return null
		// Detach from the file: a synced folder may replace it under us.
		return new Blob([await f.arrayBuffer()], {type: f.type || 'image/jpeg'})
	}
}
