import vue from '@vitejs/plugin-vue'
import {cpSync, existsSync, readdirSync} from 'fs'
import {fileURLToPath} from 'url'
import {defineConfig, type Plugin} from 'vite'
import glsl from 'vite-plugin-glsl'
import monacoEditorPlugin, {
	type IMonacoEditorOpts,
} from 'vite-plugin-monaco-editor'
import {VitePWA} from 'vite-plugin-pwa'
const monacoEditorPluginDefault = (monacoEditorPlugin as any).default as (
	options: IMonacoEditorOpts
) => any
// import electron from 'vite-plugin-electron/simple'

/**
 * `public/_dev-*` are local symlinks to real project folders, served by the
 * dev server for the exhibit page's `?seed=` path. They must never end up in
 * dist/ (gigabytes of stills, and a dangling link aborts the build), so the
 * build copies public/ itself, skipping them.
 */
function publicWithoutDevLinks(): Plugin {
	const publicDir = fileURLToPath(new URL('./public', import.meta.url))
	let outDir = 'dist'
	return {
		name: 'koma:public-without-dev-links',
		apply: 'build',
		config: () => ({build: {copyPublicDir: false}}),
		configResolved(cfg) {
			outDir = cfg.build.outDir
		},
		closeBundle() {
			if (!existsSync(publicDir)) return
			for (const name of readdirSync(publicDir)) {
				if (name.startsWith('_dev-')) continue
				cpSync(`${publicDir}/${name}`, `${outDir}/${name}`, {recursive: true, dereference: true})
			}
		},
	}
}

export default defineConfig({
	base: './',
	server: {
		port: 5555,
		// No HMR: this tab holds the camera (WebUSB) and every serial port, and
		// a hot update or an automatic full reload mid-cut would tear those
		// down under a running machine. Code changes apply on an explicit
		// reload only.
		hmr: false,
	},
	plugins: [
		publicWithoutDevLinks(),
		glsl(),
		vue(),
		monacoEditorPluginDefault({
			languageWorkers: ['editorWorkerService', 'typescript', 'json'],
		}),
		VitePWA({
			registerType: 'autoUpdate',
			injectRegister: 'auto',
			devOptions: {
				// Disabled in dev: the service worker caches modules (incl. tweeq
				// source) ahead of the HTTP/Vite cache, serving stale code that
				// survives hard reloads and `node_modules/.vite` clears.
				enabled: false,
			},
			manifest: {
				name: 'Koma / Milling',
				short_name: 'Koma',
				display: 'standalone',
				display_override: ['window-controls-overlay', 'standalone'],
				theme_color: '#000000',
				icons: [
					{
						src: 'icon.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'any',
					},
				],
			},
			workbox: {
				maximumFileSizeToCacheInBytes: 100 * 1024 * 1024,
				// The service worker answers navigations it has no exact entry for
				// with index.html. exhibit.html / jog.html are opened with a query
				// (?screen=a), which is not an exact entry: they got koma's main
				// page instead, from the second visit on. Those, and the relay's own
				// paths, go to the network.
				navigateFallbackDenylist: [/\/(exhibit|jog)\.html/, /\/api\//, /\/project\//, /\/ws/],
			},
		}),
		// electron({
		// 	main: {
		// 		entry: 'src/electron-main.ts',
		// 	},
		// }),
	],
	build: {
		sourcemap: true,
		rollupOptions: {
			input: {
				main: fileURLToPath(new URL('./index.html', import.meta.url)),
				// Exhibition screens (ADDSUB.md §15): a separate page at /exhibit.html
				exhibit: fileURLToPath(new URL('./exhibit.html', import.meta.url)),
				// Phone jog pendant over koma-relay: /jog.html
				jog: fileURLToPath(new URL('./jog.html', import.meta.url)),
			},
		},
	},
	resolve: {
		alias: [
			{
				find: '@',
				replacement: fileURLToPath(new URL('./src', import.meta.url)),
			},
			{
				find: 'tweeq',
				replacement: fileURLToPath(
					new URL('./dev_modules/tweeq/src', import.meta.url)
				),
			},
			{
				find: 'tethr',
				replacement: fileURLToPath(
					new URL('./dev_modules/tethr/core/src', import.meta.url)
				),
			},
			{
				find: 'ws-fanout',
				replacement: fileURLToPath(
					new URL('./dev_modules/ws-fanout/sender/src', import.meta.url)
				),
			},
			{
				find: '@tethr/vue3',
				replacement: fileURLToPath(
					new URL('./dev_modules/tethr/integrations/vue3/src', import.meta.url)
				),
			},
		],
	},
	define: {
		// This is needed to make the PromiseQueue class available in the browser.
		'process.env.PROMISE_QUEUE_COVERAGE': false,
	},
})
