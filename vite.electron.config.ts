/**
 * Vite config for the desktop (Electron) build: the same renderer as the
 * browser build minus the PWA service worker, plus the main process and
 * preload. `yarn app` for dev (Electron on the dev server), `yarn app:build`
 * to emit build/renderer + build/electron, `yarn app:pack` for the .app / .dmg.
 */
import {defineConfig, mergeConfig} from 'vite'
import electron from 'vite-plugin-electron/simple'

import {createConfig} from './vite.config'

export default defineConfig(
	mergeConfig(createConfig({electron: true}), {
		plugins: [
			electron({
				main: {
					entry: 'electron/main.ts',
					vite: {
						build: {
							outDir: 'build/electron',
							rollupOptions: {
								// Shipped as node_modules in the package (see
								// electron-builder.yml) rather than bundled: osc-js
								// requires ws / dgram at run time.
								external: ['osc-js', 'ws'],
							},
						},
					},
				},
				preload: {
					input: 'electron/preload.ts',
					vite: {
						build: {
							outDir: 'build/electron',
							rollupOptions: {
								// A sandboxed preload must be CommonJS.
								output: {format: 'cjs', entryFileNames: '[name].cjs'},
							},
						},
					},
				},
			}),
		],
	})
)
