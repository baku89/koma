import vue from '@vitejs/plugin-vue'
import {fileURLToPath} from 'url'
import {defineConfig} from 'vite'
import glsl from 'vite-plugin-glsl'
import monacoEditorPlugin, {
	type IMonacoEditorOpts,
} from 'vite-plugin-monaco-editor'
import {VitePWA} from 'vite-plugin-pwa'
const monacoEditorPluginDefault = (monacoEditorPlugin as any).default as (
	options: IMonacoEditorOpts
) => any

export default defineConfig({
	base: './',
	server: {
		port: 5555,
	},
	plugins: [
		glsl(),
		vue(),
		monacoEditorPluginDefault({
			languageWorkers: ['editorWorkerService', 'typescript', 'json'],
		}),
		VitePWA({
			registerType: 'autoUpdate',
			injectRegister: 'auto',
			devOptions: {
				enabled: true,
			},
			manifest: {
				name: 'Koma',
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
		}),
	],
	build: {
		sourcemap: true,
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
					new URL('../tethr/core/src', import.meta.url)
				),
			},
		],
	},
	define: {
		// This is needed to make the PromiseQueue class available in the browser.
		'process.env.PROMISE_QUEUE_COVERAGE': false,
	},
})
