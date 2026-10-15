/**
 * reconcileAssets against an in-memory File System Access API: layer folders
 * (`Main/0001.jpg`), trash subfolders, folder renames, the copy+delete
 * fallback for handles without move(), and the flat legacy layout.
 */
import {beforeEach, describe, expect, it} from 'vitest'

import {
	clearAssets,
	getAssetFilename,
	liveAssetPaths,
	reconcileAssets,
	registerCapturedAsset,
	registerDiskAsset,
	registerTrashedAsset,
	relocateTrashedAssets,
	resolveBlob,
} from './assets'

class FakeFileHandle {
	readonly kind = 'file'
	constructor(
		public name: string,
		public parent: FakeDirHandle,
		public data: Uint8Array,
		private canMove: boolean
	) {}
	async getFile() {
		return new File([this.data as BlobPart], this.name)
	}
	async createWritable() {
		const chunks: BlobPart[] = []
		return {
			write: async (c: BlobPart) => void chunks.push(c),
			close: async () => {
				this.data = new Uint8Array(await new Blob(chunks).arrayBuffer())
			},
		}
	}
	async move(a: FakeDirHandle | string, b?: string) {
		if (!this.canMove) throw new Error('move() not supported')
		const dir = typeof a === 'string' ? this.parent : a
		const name = typeof a === 'string' ? a : b!
		this.parent.entries.delete(this.name)
		this.parent = dir
		this.name = name
		dir.entries.set(name, this)
	}
	async isSameEntry(o: unknown) {
		return o === this
	}
}

class FakeDirHandle {
	readonly kind = 'directory'
	entries = new Map<string, FakeDirHandle | FakeFileHandle>()
	constructor(
		public name: string,
		private canMove = true
	) {}
	async getDirectoryHandle(name: string, opts?: {create?: boolean}) {
		const e = this.entries.get(name)
		if (e instanceof FakeDirHandle) return e
		if (e) throw new DOMException('TypeMismatchError')
		if (!opts?.create) throw new DOMException('NotFoundError')
		const d = new FakeDirHandle(name, this.canMove)
		this.entries.set(name, d)
		return d
	}
	async getFileHandle(name: string, opts?: {create?: boolean}) {
		const e = this.entries.get(name)
		if (e instanceof FakeFileHandle) return e
		if (e) throw new DOMException('TypeMismatchError')
		if (!opts?.create) throw new DOMException('NotFoundError')
		const f = new FakeFileHandle(name, this, new Uint8Array(), this.canMove)
		this.entries.set(name, f)
		return f
	}
	async removeEntry(name: string) {
		const e = this.entries.get(name)
		if (!e) throw new DOMException('NotFoundError')
		if (e instanceof FakeDirHandle && e.entries.size > 0) throw new DOMException('InvalidModificationError')
		this.entries.delete(name)
	}
	async *keys() {
		yield* [...this.entries.keys()]
	}
	async *[Symbol.asyncIterator]() {
		yield* [...this.entries.entries()]
	}
	async isSameEntry(o: unknown) {
		return o === this
	}
	/** Every file path, sorted — what the folder looks like. */
	tree(prefix = ''): string[] {
		const out: string[] = []
		for (const [name, e] of this.entries) {
			if (e instanceof FakeDirHandle) {
				const sub = e.tree(`${prefix}${name}/`)
				out.push(...(sub.length ? sub : [`${prefix}${name}/`]))
			} else out.push(`${prefix}${name}`)
		}
		return out.sort()
	}
	file(path: string): FakeFileHandle | undefined {
		const parts = path.split('/')
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		let d: FakeDirHandle = this
		for (const p of parts.slice(0, -1)) {
			const e = d.entries.get(p)
			if (!(e instanceof FakeDirHandle)) return undefined
			d = e
		}
		const f = d.entries.get(parts[parts.length - 1])
		return f instanceof FakeFileHandle ? f : undefined
	}
}

const root = (canMove = true) => new FakeDirHandle('project', canMove) as unknown as FileSystemDirectoryHandle
const asFake = (d: FileSystemDirectoryHandle) => d as unknown as FakeDirHandle
const bytes = (s: string) => new Blob([s])
const text = async (b: Blob | undefined) => (b ? await b.text() : undefined)

beforeEach(() => clearAssets())

describe('reconcileAssets with layer folders', () => {
	it('writes captured frames into the layer folder', async () => {
		const dir = root()
		const jpg = registerCapturedAsset(bytes('J'), 'Main/0001.jpg')
		const lv = registerCapturedAsset(bytes('L'), 'Main/0001.lv.jpg')
		await reconcileAssets(dir, [{id: jpg, name: 'Main/0001.jpg'}, {id: lv, name: 'Main/0001.lv.jpg'}], new Set([jpg, lv]))
		expect(asFake(dir).tree()).toEqual(['Main/0001.jpg', 'Main/0001.lv.jpg'])
		expect(await text(await resolveBlob(jpg))).toBe('J')
		expect(liveAssetPaths()).toEqual(new Set(['Main/0001.jpg', 'Main/0001.lv.jpg']))
	})

	it('trashes into _trash/<layer>/ and restores from there; empty folders go', async () => {
		const dir = root()
		const a = registerCapturedAsset(bytes('A'), 'Main/0001.jpg')
		const b = registerCapturedAsset(bytes('B'), 'Main/0002.jpg')
		const live = [{id: a, name: 'Main/0001.jpg'}, {id: b, name: 'Main/0002.jpg'}]
		await reconcileAssets(dir, live, new Set([a, b]))

		// Delete frame 1: b shifts down, a is displaced.
		await reconcileAssets(dir, [{id: b, name: 'Main/0001.jpg'}], new Set([b]), [a])
		expect(asFake(dir).tree()).toEqual(['Main/0001.jpg', `_trash/Main/${a}__0001.jpg`])
		expect(getAssetFilename(a)).toBe(`Main/${a}__0001.jpg`)
		expect(await text(await resolveBlob(b))).toBe('B')

		// Undo: a back to 0001, b back to 0002 (a cascade with a free name).
		await reconcileAssets(dir, live, new Set([a, b]), [])
		// `_trash/Main` emptied → removed; `_trash` itself stays (empty).
		expect(asFake(dir).tree()).toEqual(['Main/0001.jpg', 'Main/0002.jpg', '_trash/'])
		expect(await text(await asFake(dir).file('Main/0001.jpg')?.getFile())).toBe('A')
	})

	it('moves a layer\'s frames when its folder is renamed and drops the empty folder', async () => {
		const dir = root()
		const a = registerCapturedAsset(bytes('A'), 'Main/0001.jpg')
		await reconcileAssets(dir, [{id: a, name: 'Main/0001.jpg'}], new Set([a]))
		await reconcileAssets(dir, [{id: a, name: 'Film/0001.jpg'}], new Set([a]))
		expect(asFake(dir).tree()).toEqual(['Film/0001.jpg'])
	})

	it('keeps a renamed layer\'s old folder while something else is in it', async () => {
		const dir = root()
		const a = registerCapturedAsset(bytes('A'), 'Main/0001.jpg')
		await reconcileAssets(dir, [{id: a, name: 'Main/0001.jpg'}], new Set([a]))
		const g = await (await asFake(dir).getDirectoryHandle('Main')).getDirectoryHandle('gcode', {create: true})
		await g.getFileHandle('0001_x.nc', {create: true})
		await reconcileAssets(dir, [{id: a, name: 'Film/0001.jpg'}], new Set([a]))
		expect(asFake(dir).tree()).toEqual(['Film/0001.jpg', 'Main/gcode/0001_x.nc'])
	})

	it('falls back to copy + delete across folders when move() is unavailable', async () => {
		const dir = root(false)
		const a = registerCapturedAsset(bytes('A'), 'Main/0001.jpg')
		await reconcileAssets(dir, [{id: a, name: 'Main/0001.jpg'}], new Set([a]))
		// Reload: a disk-backed entry with no in-memory bytes.
		clearAssets()
		const a2 = registerDiskAsset('Main/0001.jpg', dir)
		await reconcileAssets(dir, [{id: a2, name: 'Take/0007.jpg'}], new Set([a2]))
		expect(asFake(dir).tree()).toEqual(['Take/0007.jpg'])
		expect(await text(await resolveBlob(a2))).toBe('A')
		await reconcileAssets(dir, [], new Set(), [a2])
		expect(asFake(dir).tree()).toEqual([`_trash/Take/${a2}__0007.jpg`])
	})

	it('relocates trashed assets by path (layer folder rename / migration)', async () => {
		const dir = root()
		const trash = await dir.getDirectoryHandle('_trash', {create: true})
		const old = await trash.getDirectoryHandle('Main', {create: true})
		await (await old.getFileHandle('x__0001.jpg', {create: true})).createWritable().then(async w => {
			await w.write('T')
			await w.close()
		})
		const t = registerTrashedAsset('Main/x__0001.jpg', trash)
		const n = await relocateTrashedAssets((_id, path) => (path.startsWith('Main/') ? `Film/${path.slice(5)}` : undefined))
		expect(n).toBe(1)
		expect(asFake(dir).tree()).toEqual(['_trash/Film/x__0001.jpg'])
		expect(getAssetFilename(t)).toBe('Film/x__0001.jpg')
		expect(await text(await resolveBlob(t))).toBe('T')
	})
})

describe('reconcileAssets on the flat layout', () => {
	it('keeps flat names flat (no folders)', async () => {
		const dir = root()
		const a = registerCapturedAsset(bytes('A'), 'film_layer=0_0001.jpg')
		await reconcileAssets(dir, [{id: a, name: 'film_layer=0_0001.jpg'}], new Set([a]))
		await reconcileAssets(dir, [], new Set(), [a])
		expect(asFake(dir).tree()).toEqual([`_trash/${a}__film_layer=0_0001.jpg`])
	})
})
