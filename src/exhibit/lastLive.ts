/**
 * The last picture the live view pane showed, held for when there is no
 * stream to show: the shooting machine is off for the night, the connection
 * dropped, or this page was reloaded while it was away (hence IndexedDB).
 */

import {get, set} from 'idb-keyval'
import {readonly, shallowRef} from 'vue'

const KEY = 'exhibit.lastLive'

const lastLive = shallowRef<{url: string; t: number} | null>(null)

function hold(blob: Blob, t: number) {
	if (lastLive.value && lastLive.value.t > t) return
	if (lastLive.value) URL.revokeObjectURL(lastLive.value.url)
	lastLive.value = {url: URL.createObjectURL(blob), t}
}

void get<{blob: Blob; t: number}>(KEY)
	.then(saved => {
		if (saved?.blob) hold(saved.blob, saved.t)
	})
	.catch(() => {})

let canvas: HTMLCanvasElement | null = null

/** Keep what `video` shows right now (nothing happens before its first frame). */
export function keepLastLive(video: HTMLVideoElement) {
	if (video.readyState < 2 || video.videoWidth === 0) return
	canvas ??= document.createElement('canvas')
	canvas.width = video.videoWidth
	canvas.height = video.videoHeight
	const ctx = canvas.getContext('2d')
	if (!ctx) return
	ctx.drawImage(video, 0, 0)
	const t = Date.now()
	canvas.toBlob(
		blob => {
			if (!blob) return
			hold(blob, t)
			void set(KEY, {blob, t}).catch(() => {})
		},
		'image/jpeg',
		0.9
	)
}

export function useLastLive() {
	return readonly(lastLive)
}
