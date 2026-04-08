import { Buffer } from 'buffer'
import type { Vault } from 'obsidian'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebDAVClient } from 'webdav'

vi.mock('~/utils/get-task-name', () => ({
	default: () => 'task',
}))

import ConflictResolveTask, {
	ConflictStrategy,
} from './conflict-resolve.task'
import PullTask from './pull.task'
import PushTask from './push.task'

const syncRecordStub = {} as never

function createVault() {
	return {
		adapter: {
			exists: vi.fn(),
			readBinary: vi.fn(),
			writeBinary: vi.fn(),
			write: vi.fn(),
			mkdir: vi.fn(),
		},
	} as unknown as Vault & {
		adapter: {
			exists: ReturnType<typeof vi.fn>
			readBinary: ReturnType<typeof vi.fn>
			writeBinary: ReturnType<typeof vi.fn>
			write: ReturnType<typeof vi.fn>
			mkdir: ReturnType<typeof vi.fn>
		}
	}
}

function createWebdav() {
	return {
		getFileContents: vi.fn(),
		putFileContents: vi.fn(),
	} as unknown as WebDAVClient & {
		getFileContents: ReturnType<typeof vi.fn>
		putFileContents: ReturnType<typeof vi.fn>
	}
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('PullTask', () => {
	it('writes downloaded content through adapter.writeBinary after mkdirs', async () => {
		const vault = createVault()
		vault.adapter.exists.mockResolvedValue(false)
		const webdav = createWebdav()
		const remoteBuffer = Uint8Array.from([1, 2, 3]).buffer
		webdav.getFileContents.mockResolvedValue(remoteBuffer)

		const task = new PullTask({
			vault,
			webdav,
			remoteBaseDir: '/remote',
			remotePath: 'folder/file.bin',
			localPath: 'folder/file.bin',
			syncRecord: syncRecordStub,
			remoteSize: 3,
		})

		await expect(task.exec()).resolves.toEqual({ success: true })
		expect(vault.adapter.mkdir).toHaveBeenCalledWith('folder')
		expect(vault.adapter.writeBinary).toHaveBeenCalledWith(
			'folder/file.bin',
			remoteBuffer,
		)
	})
})

describe('PushTask', () => {
	it('reads local content through adapter before uploading', async () => {
		const vault = createVault()
		const localBuffer = Uint8Array.from([9, 8]).buffer
		vault.adapter.exists.mockResolvedValue(true)
		vault.adapter.readBinary.mockResolvedValue(localBuffer)
		const webdav = createWebdav()
		webdav.putFileContents.mockResolvedValue(true)

		const task = new PushTask({
			vault,
			webdav,
			remoteBaseDir: '/remote',
			remotePath: 'file.bin',
			localPath: 'file.bin',
			syncRecord: syncRecordStub,
		})

		await expect(task.exec()).resolves.toEqual({ success: true })
		expect(vault.adapter.readBinary).toHaveBeenCalledWith('file.bin')
		expect(webdav.putFileContents).toHaveBeenCalledWith('/remote/file.bin', localBuffer, {
			overwrite: true,
		})
	})
})

describe('ConflictResolveTask', () => {
	it('uses adapter.writeBinary when latest timestamp chooses remote content', async () => {
		const vault = createVault()
		vault.adapter.exists.mockResolvedValue(true)
		vault.adapter.readBinary.mockResolvedValue(Buffer.from('local').buffer)
		const webdav = createWebdav()
		const remoteContent = Buffer.from('remote')
		webdav.getFileContents.mockResolvedValue(remoteContent)

		const task = new ConflictResolveTask({
			vault,
			webdav,
			remoteBaseDir: '/remote',
			remotePath: 'note.md',
			localPath: 'note.md',
			syncRecord: syncRecordStub,
			strategy: ConflictStrategy.LatestTimeStamp,
			useGitStyle: false,
			localStat: {
				path: 'note.md',
				basename: 'note.md',
				isDir: false,
				isDeleted: false,
				mtime: 1,
				size: 5,
			},
			remoteStat: {
				path: 'note.md',
				basename: 'note.md',
				isDir: false,
				isDeleted: false,
				mtime: 2,
				size: 6,
			},
		})

		await expect(task.exec()).resolves.toEqual({ success: true })
		expect(vault.adapter.writeBinary).toHaveBeenCalledTimes(1)
		expect(vault.adapter.writeBinary.mock.calls[0]?.[0]).toBe('note.md')
	})

	it('uses adapter.write for merged text updates', async () => {
		const vault = createVault()
		vault.adapter.exists.mockResolvedValue(true)
		vault.adapter.readBinary.mockResolvedValue(Buffer.from('hello world').buffer)
		const webdav = createWebdav()
		webdav.getFileContents.mockResolvedValue(Buffer.from('hello brave world'))
		webdav.putFileContents.mockResolvedValue(true)

		const task = new ConflictResolveTask({
			vault,
			webdav,
			remoteBaseDir: '/remote',
			remotePath: 'note.md',
			localPath: 'note.md',
			syncRecord: syncRecordStub,
			strategy: ConflictStrategy.DiffMatchPatch,
			useGitStyle: false,
			record: {
				local: {
					path: 'note.md',
					basename: 'note.md',
					isDir: false,
					isDeleted: false,
					mtime: 1,
					size: 11,
				},
				remote: {
					path: 'note.md',
					basename: 'note.md',
					isDir: false,
					isDeleted: false,
					mtime: 2,
					size: 17,
				},
			},
			localStat: {
				path: 'note.md',
				basename: 'note.md',
				isDir: false,
				isDeleted: false,
				mtime: 1,
				size: 11,
			},
			remoteStat: {
				path: 'note.md',
				basename: 'note.md',
				isDir: false,
				isDeleted: false,
				mtime: 2,
				size: 17,
			},
		})

		await expect(task.exec()).resolves.toEqual({ success: true })
		expect(vault.adapter.write).toHaveBeenCalledTimes(1)
		expect(vault.adapter.write.mock.calls[0]?.[0]).toBe('note.md')
	})
})
