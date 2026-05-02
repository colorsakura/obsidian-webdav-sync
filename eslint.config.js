import eslint from '@eslint/js'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'
import globals from 'globals'

export default [
	{
		ignores: [
			'node_modules',
			'dist',
			'build',
			'*.js',
			'__mocks__',
			'**/*.test.ts',
			'packages',
		],
	},
	{
		...eslint.configs.recommended,
		files: ['**/*.ts'],
		languageOptions: {
			parser: tsparser,
			parserOptions: {
				ecmaVersion: 'latest',
				sourceType: 'module',
			},
			globals: {
				...globals.browser,
				...globals.es2021,
			},
		},
		plugins: {
			'@typescript-eslint': tseslint,
		},
		rules: {
			...tseslint.configs.recommended.rules,
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],
			'no-console': ['warn', { allow: ['warn', 'error'] }],
			'no-var': 'error',
			'prefer-const': 'off',
			'prefer-arrow-callback': 'error',
			'object-shorthand': 'error',
			'no-undef': 'off',
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/explicit-function-return-type': 'off',
			'@typescript-eslint/no-non-null-assertion': 'off',
			'@typescript-eslint/no-empty-function': 'off',
			'@typescript-eslint/ban-types': 'off',
			'@typescript-eslint/no-inferrable-types': 'off',
			'@typescript-eslint/no-require-imports': 'off',
			'@typescript-eslint/no-empty-object-type': 'off',
			// Disable consistent-type-imports - causes runtime issues with Obsidian types
			'@typescript-eslint/consistent-type-imports': 'off',
		},
	},
]
