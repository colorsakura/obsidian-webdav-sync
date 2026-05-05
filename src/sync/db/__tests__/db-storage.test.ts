import { describe, it, expect, vi } from 'vitest'
import { SyncDB } from '../sync-db'
import { DBStorage } from '../db-storage'

function createMockWebdav() {
	const files = new Map<string, ArrayBuffer>()
	return {
		getFileContents: vi.fn().mockImplementation(async (path: string) => {
			const content = files.get(path)
			if (!content) {
				const err = new Error('Not Found') as any
				err.status = 404
				throw err
			}
			return content
		}),
		putFileContents: vi
			.fn()
			.mockImplementation(async (path: string, content: ArrayBuffer) => {
				files.set(path, content)
				return true
			}),
	} as any
}

describe('DBStorage', () => {
	describe('download', () => {
		it('应该下载远端 DB 并返回 SyncDB 实例', async () => {
			const webdav = createMockWebdav()
			const storage = new DBStorage(webdav, '/remote')

			const sourceDB = await SyncDB.empty('device-remote')
			sourceDB.upsertFile({
				path: 'test.md',
				mtime: 1000,
				size: 50,
				hash: 'a'.repeat(64),
				isDir: 0,
			})
			await storage.upload(sourceDB)

			const downloaded = await storage.download()
			expect(downloaded).toBeDefined()
			expect(downloaded!.getAllFiles()).toEqual(sourceDB.getAllFiles())
		})

		it('DB 不存在时应该返回 null', async () => {
			const webdav = createMockWebdav()
			const storage = new DBStorage(webdav, '/remote')

			const result = await storage.download()
			expect(result).toBeNull()
		})
	})

	describe('upload', () => {
		it('应该上传 DB 到远端', async () => {
			const webdav = createMockWebdav()
			const storage = new DBStorage(webdav, '/remote')

			const db = await SyncDB.empty('device-1')
			db.upsertFile({
				path: 'note.md',
				mtime: 1000,
				size: 100,
				hash: 'b'.repeat(64),
				isDir: 0,
			})

			await storage.upload(db)
			expect(webdav.putFileContents).toHaveBeenCalledWith(
				'/remote/_sync/db',
				expect.any(ArrayBuffer),
				expect.objectContaining({ overwrite: true }),
			)
		})
	})

	describe('validate', () => {
		it('有效 DB 应该通过校验', async () => {
			const db = await SyncDB.empty('device-1')
			const buffer = db.toBuffer()
			const result = await DBStorage.validate(buffer)
			expect(result).toBe(true)
		})

		it('损坏数据应该校验失败', async () => {
			const buffer = new ArrayBuffer(100)
			const view = new Uint8Array(buffer)
			for (let i = 0; i < view.length; i++) {
				view[i] = Math.floor(Math.random() * 256)
			}
			const result = await DBStorage.validate(buffer)
			expect(result).toBe(false)
		})
	})
})
