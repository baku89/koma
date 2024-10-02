import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {FlatCompat} from '@eslint/eslintrc'
import js from '@eslint/js'
import typescriptEslint from '@typescript-eslint/eslint-plugin'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import unusedImports from 'eslint-plugin-unused-imports'
import globals from 'globals'
import parser from 'vue-eslint-parser'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const compat = new FlatCompat({
	baseDirectory: __dirname,
	recommendedConfig: js.configs.recommended,
	allConfig: js.configs.all,
})

export default [
	...compat.extends(
		'eslint:recommended',
		'plugin:@typescript-eslint/recommended',
		'plugin:vue/vue3-essential',
		'prettier'
	),
	{
		plugins: {
			'@typescript-eslint': typescriptEslint,
			'simple-import-sort': simpleImportSort,
			'unused-imports': unusedImports,
		},

		languageOptions: {
			globals: {
				...globals.node,
			},

			parser,
			ecmaVersion: 2022,
			sourceType: 'module',

			parserOptions: {
				parser: '@typescript-eslint/parser',
			},
		},

		rules: {
			'arrow-body-style': 'off',
			'prefer-arrow-callback': 'off',
			'no-console': 'warn',
			'no-debugger': 'warn',
			eqeqeq: 'error',
			'prefer-const': 'error',
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-namespace': 'off',
			'simple-import-sort/imports': 'error',
			'simple-import-sort/exports': 'error',
			'unused-imports/no-unused-imports': 'error',
			'vue/no-multiple-template-root': 'off',
			'vue/multi-word-component-names': 'off',
			'vue/no-v-model-argument': 'off',
			'vue/attribute-hyphenation': 'off',
			'vue/require-default-prop': 'off',
		},
	},
]
