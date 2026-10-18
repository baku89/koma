/**
 * Screen A's video: the takes encoded to MP4 (utils/mp4) and cached in OPFS by
 * the take-list signature, rebuilt in the background when new takes appear
 * (§15.2 — "ffmpeg とかで動画化", done without a native dependency).
 */

export type {EncodeOptions, EncodeSource} from '@/utils/mp4'
export {encodeTakesToMp4, isEncodingSupported} from '@/utils/mp4'

//------------------------------------------------------------------------------
// OPFS cache

const CACHE_DIR = 'exhibit-video'

async function cacheDir() {
	const root = await navigator.storage.getDirectory()
	return root.getDirectoryHandle(CACHE_DIR, {create: true})
}

function cacheName(signature: string) {
	// Signature may contain characters OPFS dislikes.
	let h = 0
	for (let i = 0; i < signature.length; i++) h = (h * 31 + signature.charCodeAt(i)) | 0
	return `takes-${(h >>> 0).toString(16)}.mp4`
}

export async function readCachedVideo(signature: string): Promise<Blob | null> {
	try {
		const dir = await cacheDir()
		const fh = await dir.getFileHandle(cacheName(signature))
		return await fh.getFile()
	} catch {
		return null
	}
}

export async function writeCachedVideo(signature: string, blob: Blob) {
	const dir = await cacheDir()
	const name = cacheName(signature)
	const fh = await dir.getFileHandle(name, {create: true})
	const w = await fh.createWritable()
	await w.write(blob)
	await w.close()
	// Keep the cache small: drop every other video.
	for await (const [entry] of dir as any) {
		if (entry !== name) await dir.removeEntry(entry).catch(() => {})
	}
}
