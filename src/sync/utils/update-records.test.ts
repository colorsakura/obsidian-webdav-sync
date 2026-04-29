import { describe, expect, it, vi } from 'vitest'
import type { Vault } from 'obsidian'

vi.mock('~/utils/get-task-name', () => ({
	default: () => 'task',
}))

import { updateMtimeInRecord } from './update-records'

const { records, setRecords, getRecords, walk, blobStoreStore } = vi.hoisted(
	() => {
		const records = new Map<string, unknown>()
		return {
			records,
			setRecords: vi.fn(async () => undefined),
			getRecords: vi.fn(async () => records),
			walk: vi.fn(async () => [
				{
					stat: {
						path: 'folder/file.md',
						basename: 'file.md',
						isDir: false,
						isDeleted: false,
						mtime: 20,
						size: 10,
					},
					ignored: false,
				},
			]),
			blobStoreStore: vi.fn(async () => ({
				key: 'blob-key',
				value: undefined,
			})),
		}
	},
)

vi.mock('~/storage/sync-record', () => {
	return {
		SyncRecord: vi.fn().mockImplementation(() => ({
			getRecords,
			setRecords,
		})),
	}
})

vi.mock('~/fs/nutstore', () => {
	return {
		NutstoreFileSystem: vi.fn().mockImplementation(() => ({
			walk,
		})),
	}
})

vi.mock('~/storage/blob', () => {
	return {
		blobStore: {
			store: blobStoreStore,
		},
	}
})

vi.mock('~/events', () => {
	return {
		emitSyncUpdateMtimeProgress: vi.fn(),
	}
})

vi.mock('~/storage', () => {
	return {
		syncRecordKV: {},
	}
})

describe('updateMtimeInRecord', () => {
	it('uses adapter stat and readBinary to persist local metadata immediately after writes', async () => {
		records.clear()
		setRecords.mockClear()
		getRecords.mockClear()
		walk.mockClear()
		blobStoreStore.mockClear()

		const vault = {
			getName: vi.fn(() => 'vault-name'),
			adapter: {
				stat: vi.fn(async (path: string) => {
					if (path === 'folder/file.md') {
						return {
							type: 'file',
							mtime: 10,
							size: 10,
						}
					}
					return null
				}),
				readBinary: vi.fn(async () => Uint8Array.from([1, 2, 3]).buffer),
			},
		} as unknown as Vault & {
			adapter: {
				stat: ReturnType<typeof vi.fn>
				readBinary: ReturnType<typeof vi.fn>
			}
			getName: ReturnType<typeof vi.fn>
		}

		const task = {
			localPath: 'folder/file.md',
			toJSON: () => ({ localPath: 'folder/file.md' }),
		}

		await updateMtimeInRecord(
			{
				getToken: vi.fn(async () => 'token'),
			} as never,
			vault,
			'/remote',
			[task as never],
			[{ success: true }],
			10,
		)

		expect(vault.adapter.stat).toHaveBeenCalledWith('folder/file.md')
		expect(vault.adapter.readBinary).toHaveBeenCalledWith('folder/file.md')
		expect(blobStoreStore).toHaveBeenCalledTimes(1)
		expect(records.get('folder/file.md')).toEqual({
			local: {
				path: 'folder/file.md',
				basename: 'file.md',
				isDir: false,
				isDeleted: false,
				mtime: 10,
				size: 10,
			},
			remote: {
				path: 'folder/file.md',
				basename: 'file.md',
				isDir: false,
				isDeleted: false,
				mtime: 20,
				size: 10,
			},
			base: {
				key: 'blob-key',
			},
		})
		expect(setRecords).toHaveBeenCalled()
	})
})
