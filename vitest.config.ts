import {fileURLToPath} from 'url'
import {defineConfig} from 'vitest/config'

// Unit tests for the DOM-free parts (FluidNC parsing, kinematics, LED layout).
// Kept separate from vite.config.ts so the PWA / Monaco plugins stay out of
// the test run.
export default defineConfig({
	resolve: {
		alias: [
			{
				find: '@',
				replacement: fileURLToPath(new URL('./src', import.meta.url)),
			},
			{
				find: 'ws-fanout',
				replacement: fileURLToPath(
					new URL('./dev_modules/ws-fanout/sender/src', import.meta.url)
				),
			},
		],
	},
	test: {
		include: ['src/**/*.test.ts'],
	},
})
