import js from '@eslint/js'
import typescriptEslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import prettierConfig from 'eslint-config-prettier/flat'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import unusedImports from 'eslint-plugin-unused-imports'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import vueParser from 'vue-eslint-parser'

export default [
	js.configs.recommended,
	typescriptEslint.configs['flat/eslint-recommended'],
	...pluginVue.configs['flat/essential'],
	{
		files: ['**/*.{ts,tsx,vue}'],
		plugins: {
			'@typescript-eslint': typescriptEslint,
			'simple-import-sort': simpleImportSort,
			'unused-imports': unusedImports,
		},
		languageOptions: {
			globals: {
				...globals.node,
				...globals.browser,
			},
			parser: vueParser,
			ecmaVersion: 2022,
			sourceType: 'module',
			parserOptions: {
				parser: tsParser,
				extraFileExtensions: ['.vue'],
			},
		},
		rules: {
			...typescriptEslint.configs.recommended.rules,
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
	prettierConfig,
]
