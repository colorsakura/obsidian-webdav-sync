import { describe, expect, it } from 'vitest'
import GlobMatch, { needIncludeFromGlobRules } from './glob-match'
import {
	computeEffectiveFilterRules,
	getConfigDirSystemFilterRules,
	getConfigDirSystemTraversalRules,
	isPathAllowedByConfigDirMode,
} from './config-dir-rules'

function createPluginMock(mode: 'none' | 'bookmarks' | 'all') {
	return {
		app: {
			vault: {
				configDir: '.obsidian',
			},
		},
		settings: {
			configDirSyncMode: mode,
			filterRules: {
				exclusionRules: [],
				inclusionRules: [],
			},
		},
	} as any
}

describe('isPathAllowedByConfigDirMode', () => {
	it('blocks all configDir paths in none mode', () => {
		expect(isPathAllowedByConfigDirMode('.obsidian', '.obsidian', 'none')).toBe(
			false,
		)
		expect(
			isPathAllowedByConfigDirMode(
				'.obsidian/workspace.json',
				'.obsidian',
				'none',
			),
		).toBe(false)
		expect(
			isPathAllowedByConfigDirMode('notes/workspace.json', '.obsidian', 'none'),
		).toBe(true)
	})

	it('allows bookmarks only inside configDir in bookmarks mode', () => {
		expect(
			isPathAllowedByConfigDirMode(
				'.obsidian/bookmarks.json',
				'.obsidian',
				'bookmarks',
			),
		).toBe(true)
		expect(
			isPathAllowedByConfigDirMode(
				'.obsidian/workspace.json',
				'.obsidian',
				'bookmarks',
			),
		).toBe(false)
		expect(isPathAllowedByConfigDirMode('.obsidian', '.obsidian', 'bookmarks')).toBe(
			false,
		)
		expect(
			isPathAllowedByConfigDirMode('notes/workspace.json', '.obsidian', 'bookmarks'),
		).toBe(true)
	})
})

describe('computeEffectiveFilterRules', () => {
	it('generates traversal and filter rules from shared system source', () => {
		const traversalRules = getConfigDirSystemTraversalRules('.obsidian')
		const filterRules = getConfigDirSystemFilterRules('.obsidian')

		expect(traversalRules).toEqual([
			{
				expr: '.obsidian/plugins/**/node_modules',
				options: { caseSensitive: true },
			},
			{ expr: '.obsidian/plugins/**/.git', options: { caseSensitive: true } },
			{
				expr: '.obsidian/plugins/**/.pnpm-store',
				options: { caseSensitive: true },
			},
		])
		expect(filterRules).toEqual(
			expect.arrayContaining([
				{
					expr: '.obsidian/plugins/**/node_modules',
					options: { caseSensitive: true },
				},
				{
					expr: '.obsidian/plugins/**/node_modules/**',
					options: { caseSensitive: true },
				},
				{ expr: '.obsidian/plugins/**/.git', options: { caseSensitive: true } },
				{ expr: '.obsidian/plugins/**/.git/**', options: { caseSensitive: true } },
				{
					expr: '.obsidian/plugins/**/.pnpm-store',
					options: { caseSensitive: true },
				},
				{
					expr: '.obsidian/plugins/**/.pnpm-store/**',
					options: { caseSensitive: true },
				},
			]),
		)
	})

	it('adds plugin dependency exclusions in all mode', () => {
		const rules = computeEffectiveFilterRules(createPluginMock('all'))
		expect(rules.exclusionRules).toEqual(
			expect.arrayContaining([
				{
					expr: '.obsidian/plugins/**/node_modules',
					options: { caseSensitive: true },
				},
				{ expr: '.obsidian/plugins/**/.git', options: { caseSensitive: true } },
				{ expr: '.obsidian/plugins/**/.git/**', options: { caseSensitive: true } },
				{
					expr: '.obsidian/plugins/**/.pnpm-store',
					options: { caseSensitive: true },
				},
				{
					expr: '.obsidian/plugins/**/.pnpm-store/**',
					options: { caseSensitive: true },
				},
				{
					expr: '.obsidian/plugins/**/node_modules/**',
					options: { caseSensitive: true },
				},
			]),
		)
	})

	it('keeps configDir mode enforcement even when inclusion matches first', () => {
		const inclusion = [new GlobMatch('**/*.json', { caseSensitive: false })]
		const exclusion = [new GlobMatch('.obsidian', { caseSensitive: false })]
		expect(
			needIncludeFromGlobRules('.obsidian/workspace.json', inclusion, exclusion),
		).toBe(true)
		expect(
			isPathAllowedByConfigDirMode('.obsidian/workspace.json', '.obsidian', 'none'),
		).toBe(false)
	})
})
