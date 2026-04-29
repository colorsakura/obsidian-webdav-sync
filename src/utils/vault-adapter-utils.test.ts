import { describe, expect, it, vi } from 'vitest'
import type { Vault } from 'obsidian'
import { mkdirsVault } from './mkdirs-vault'
import { statVaultItem } from './stat-vault-item'
import { traverseLocalVault } from './traverse-local-vault'

type AdapterMock = {
	stat: ReturnType<typeof vi.fn>
	exists: ReturnType<typeof vi.fn>
	list: ReturnType<typeof vi.fn>
	mkdir: ReturnType<typeof vi.fn>
}

function createVault(adapterOverrides: Partial<AdapterMock> = {}) {
	const adapter: AdapterMock = {
		stat: vi.fn(),
		exists: vi.fn(),
		list: vi.fn(),
		mkdir: vi.fn(),
		...adapterOverrides,
	}

	return {
		adapter,
		configDir: '.obsidian',
	} as unknown as Vault & { adapter: AdapterMock; configDir: string }
}

describe('statVaultItem', () => {
	it('reads file metadata from adapter.stat', async () => {
		const vault = createVault({
			stat: vi.fn().mockResolvedValue({
				type: 'file',
				mtime: 123,
				size: 456,
			}),
		})

		await expect(statVaultItem(vault, 'folder/note.md')).resolves.toEqual({
			path: 'folder/note.md',
			basename: 'note.md',
			isDir: false,
			isDeleted: false,
			mtime: 123,
			size: 456,
		})
	})

	it('returns directory metadata from adapter.stat', async () => {
		const vault = createVault({
			stat: vi.fn().mockResolvedValue({
				type: 'folder',
				mtime: 99,
				size: 0,
			}),
		})

		await expect(statVaultItem(vault, 'folder')).resolves.toEqual({
			path: 'folder',
			basename: 'folder',
			isDir: true,
			isDeleted: false,
			mtime: 99,
		})
	})

	it('returns undefined when the path is missing', async () => {
		const vault = createVault({
			stat: vi.fn().mockResolvedValue(null),
		})

		await expect(statVaultItem(vault, 'missing.md')).resolves.toBeUndefined()
	})
})

describe('mkdirsVault', () => {
	it('creates missing parent directories from top to bottom', async () => {
		const existing = new Set<string>()
		const mkdir = vi.fn(async (path: string) => {
			existing.add(path)
		})
		const vault = createVault({
			exists: vi.fn(async (path: string) => existing.has(path)),
			mkdir,
		})

		await mkdirsVault(vault, 'a/b/c')

		expect(mkdir.mock.calls.map(([path]) => path)).toEqual([
			'a',
			'a/b',
			'a/b/c',
		])
	})

	it('skips work for root-like paths and existing directories', async () => {
		const mkdir = vi.fn()
		const vault = createVault({
			exists: vi.fn(async (path: string) => path === 'exists'),
			mkdir,
		})

		await mkdirsVault(vault, '.')
		await mkdirsVault(vault, '/')
		await mkdirsVault(vault, 'exists')

		expect(mkdir).not.toHaveBeenCalled()
	})
})

describe('traverseLocalVault', () => {
	it('walks adapter.list recursively and ignores config node_modules', async () => {
		const vault = createVault({
			stat: vi.fn(async (path: string) => {
				const folders = new Set([
					'',
					'docs',
					'.obsidian',
					'.obsidian/plugins',
					'.obsidian/plugins/test',
					'.obsidian/plugins/test/node_modules',
				])
				if (folders.has(path)) {
					return { type: 'folder', mtime: 1, size: 0 }
				}
				if (path === 'readme.md' || path === 'docs/file.md') {
					return { type: 'file', mtime: 2, size: 3 }
				}
				if (path === '.obsidian/plugins/test/node_modules/dep.js') {
					return { type: 'file', mtime: 4, size: 5 }
				}
				return null
			}),
			list: vi.fn(async (path: string) => {
				if (path === '') {
					return {
						files: ['readme.md'],
						folders: ['docs', '.obsidian'],
					}
				}
				if (path === 'docs') {
					return {
						files: ['docs/file.md'],
						folders: [],
					}
				}
				if (path === '.obsidian') {
					return {
						files: [],
						folders: ['.obsidian/plugins'],
					}
				}
				if (path === '.obsidian/plugins') {
					return {
						files: [],
						folders: ['.obsidian/plugins/test'],
					}
				}
				if (path === '.obsidian/plugins/test') {
					return {
						files: [],
						folders: ['.obsidian/plugins/test/node_modules'],
					}
				}
				if (path === '.obsidian/plugins/test/node_modules') {
					return {
						files: ['.obsidian/plugins/test/node_modules/dep.js'],
						folders: [],
					}
				}
				return { files: [], folders: [] }
			}),
		})

		const results = await traverseLocalVault(vault, '')

		expect(results.map((item) => item.path)).toEqual([
			'readme.md',
			'docs',
			'.obsidian',
			'docs/file.md',
			'.obsidian/plugins',
			'.obsidian/plugins/test',
		])
	})

	it('returns an empty array when the start path is not a folder', async () => {
		const vault = createVault({
			stat: vi.fn().mockResolvedValue(null),
			list: vi.fn(),
		})

		await expect(traverseLocalVault(vault, 'missing')).resolves.toEqual([])
		expect(vault.adapter.list).not.toHaveBeenCalled()
	})
})
