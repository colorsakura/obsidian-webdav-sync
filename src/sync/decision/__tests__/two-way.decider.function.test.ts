import { describe, it, expect, vi } from 'vitest'
import { twoWayDecider } from '../two-way.decider.function'
import { SyncDB } from '../../db/sync-db'
import type { SyncDecisionInput, TaskFactory } from '../sync-decision.interface'
import type { BaseTask } from '../../tasks/task.interface'
import type { SyncMode } from '~/settings'
const SKIP_REASON_FILE_TOO_LARGE = 'file-too-large'

function createMockTaskFactory(): TaskFactory {
	const createTask = (type: string) =>
		vi.fn().mockImplementation(
			(opts: any) =>
				({
					type,
					options: opts,
					exec: async () => ({ success: true }),
					localPath: opts.localPath,
					remotePath: opts.remotePath,
				}) as any as BaseTask,
		)

	return {
		createPullTask: createTask('pull'),
		createPushTask: createTask('push'),
		createConflictResolveTask: createTask('conflict'),
		createNoopTask: createTask('noop'),
		createRemoveLocalTask: createTask('remove-local'),
		createRemoveRemoteTask: createTask('remove-remote'),
		createMkdirLocalTask: createTask('mkdir-local'),
		createMkdirRemoteTask: createTask('mkdir-remote'),
		createCleanRecordTask: createTask('clean-record'),
		createFilenameErrorTask: createTask('filename-error'),
		createSkippedTask: createTask('skipped'),
	}
}

const defaultSettings = {
	skipLargeFiles: { maxSize: '' },
	conflictStrategy: 'latest-timestamp' as any,
	useGitStyle: false,
	syncMode: 'strict' as SyncMode,
	configDir: '.obsidian',
	encryptionEnabled: false,
}

describe('twoWayDecider (DB-based)', () => {
	it('本地新增文件应该生成 Push 任务', async () => {
		const localDB = await SyncDB.empty('device-1')
		localDB.upsertFile({
			path: 'new.md',
			mtime: 1000,
			size: 100,
			hash: 'a'.repeat(64),
			isDir: 0,
		})
		const remoteDB = await SyncDB.empty('device-2')
		const lastSyncDB = await SyncDB.empty('device-1')

		const factory = createMockTaskFactory()
		const input: SyncDecisionInput = {
			settings: defaultSettings,
			localDB,
			remoteDB,
			lastSyncDB,
			remoteBaseDir: '/remote',
			taskFactory: factory,
		}

		await twoWayDecider(input)
		expect(factory.createPushTask).toHaveBeenCalledWith(
			expect.objectContaining({ localPath: 'new.md' }),
		)
	})

	it('远端新增文件应该生成 Pull 任务', async () => {
		const localDB = await SyncDB.empty('device-1')
		const remoteDB = await SyncDB.empty('device-2')
		remoteDB.upsertFile({
			path: 'remote-new.md',
			mtime: 1000,
			size: 200,
			hash: 'b'.repeat(64),
			isDir: 0,
		})
		const lastSyncDB = await SyncDB.empty('device-1')

		const factory = createMockTaskFactory()
		await twoWayDecider({
			settings: defaultSettings,
			localDB,
			remoteDB,
			lastSyncDB,
			remoteBaseDir: '/remote',
			taskFactory: factory,
		})

		expect(factory.createPullTask).toHaveBeenCalledWith(
			expect.objectContaining({ remoteSize: 200 }),
		)
	})

	it('hash 相同 → Noop', async () => {
		const db1 = await SyncDB.empty('device-1')
		db1.upsertFile({
			path: 'same.md',
			mtime: 1000,
			size: 100,
			hash: 'c'.repeat(64),
			isDir: 0,
		})
		const db2 = await SyncDB.empty('device-2')
		db2.upsertFile({
			path: 'same.md',
			mtime: 1000,
			size: 100,
			hash: 'c'.repeat(64),
			isDir: 0,
		})
		const db3 = await SyncDB.empty('device-1')
		db3.upsertFile({
			path: 'same.md',
			mtime: 1000,
			size: 100,
			hash: 'c'.repeat(64),
			isDir: 0,
		})

		const factory = createMockTaskFactory()
		await twoWayDecider({
			settings: defaultSettings,
			localDB: db1,
			remoteDB: db2,
			lastSyncDB: db3,
			remoteBaseDir: '/remote',
			taskFactory: factory,
		})

		expect(factory.createNoopTask).toHaveBeenCalled()
		expect(factory.createPushTask).not.toHaveBeenCalled()
		expect(factory.createPullTask).not.toHaveBeenCalled()
	})

	it('本地修改 + 远端未改 → Push', async () => {
		const localDB = await SyncDB.empty('device-1')
		localDB.upsertFile({
			path: 'edit.md',
			mtime: 2000,
			size: 150,
			hash: 'new-hash'.padEnd(64, 'x'),
			isDir: 0,
		})
		const remoteDB = await SyncDB.empty('device-2')
		remoteDB.upsertFile({
			path: 'edit.md',
			mtime: 1000,
			size: 100,
			hash: 'old-hash'.padEnd(64, 'x'),
			isDir: 0,
		})
		const lastSyncDB = await SyncDB.empty('device-1')
		lastSyncDB.upsertFile({
			path: 'edit.md',
			mtime: 1000,
			size: 100,
			hash: 'old-hash'.padEnd(64, 'x'),
			isDir: 0,
		})

		const factory = createMockTaskFactory()
		await twoWayDecider({
			settings: defaultSettings,
			localDB,
			remoteDB,
			lastSyncDB,
			remoteBaseDir: '/remote',
			taskFactory: factory,
		})

		expect(factory.createPushTask).toHaveBeenCalledWith(
			expect.objectContaining({ localPath: 'edit.md' }),
		)
	})

	it('双方修改同文件 → Conflict', async () => {
		const localDB = await SyncDB.empty('device-1')
		localDB.upsertFile({
			path: 'conflict.md',
			mtime: 2000,
			size: 150,
			hash: 'local-hash'.padEnd(64, 'x'),
			isDir: 0,
		})
		const remoteDB = await SyncDB.empty('device-2')
		remoteDB.upsertFile({
			path: 'conflict.md',
			mtime: 3000,
			size: 160,
			hash: 'remote-hash'.padEnd(64, 'x'),
			isDir: 0,
		})
		const lastSyncDB = await SyncDB.empty('device-1')
		lastSyncDB.upsertFile({
			path: 'conflict.md',
			mtime: 1000,
			size: 100,
			hash: 'base-hash'.padEnd(64, 'x'),
			isDir: 0,
		})

		const factory = createMockTaskFactory()
		await twoWayDecider({
			settings: defaultSettings,
			localDB,
			remoteDB,
			lastSyncDB,
			remoteBaseDir: '/remote',
			taskFactory: factory,
		})

		expect(factory.createConflictResolveTask).toHaveBeenCalledWith(
			expect.objectContaining({ localPath: 'conflict.md' }),
		)
	})

	it('本地删除 + 远端未改 → RemoveRemote', async () => {
		const localDB = await SyncDB.empty('device-1')
		const remoteDB = await SyncDB.empty('device-2')
		remoteDB.upsertFile({
			path: 'del.md',
			mtime: 1000,
			size: 100,
			hash: 'd'.repeat(64),
			isDir: 0,
		})
		const lastSyncDB = await SyncDB.empty('device-1')
		lastSyncDB.upsertFile({
			path: 'del.md',
			mtime: 1000,
			size: 100,
			hash: 'd'.repeat(64),
			isDir: 0,
		})

		const factory = createMockTaskFactory()
		await twoWayDecider({
			settings: defaultSettings,
			localDB,
			remoteDB,
			lastSyncDB,
			remoteBaseDir: '/remote',
			taskFactory: factory,
		})

		expect(factory.createRemoveRemoteTask).toHaveBeenCalledWith(
			expect.objectContaining({ localPath: 'del.md' }),
		)
	})

	// I3: 远端删除 + 本地未改 → RemoveLocal
	it('远端删除 + 本地未改 → RemoveLocal', async () => {
		const localDB = await SyncDB.empty('device-1')
		localDB.upsertFile({
			path: 'remote-deleted.md',
			mtime: 1000,
			size: 100,
			hash: 'd'.repeat(64),
			isDir: 0,
		})
		const remoteDB = await SyncDB.empty('device-2')
		const lastSyncDB = await SyncDB.empty('device-1')
		lastSyncDB.upsertFile({
			path: 'remote-deleted.md',
			mtime: 1000,
			size: 100,
			hash: 'd'.repeat(64),
			isDir: 0,
		})

		const factory = createMockTaskFactory()
		await twoWayDecider({
			settings: defaultSettings,
			localDB,
			remoteDB,
			lastSyncDB,
			remoteBaseDir: '/remote',
			taskFactory: factory,
		})

		expect(factory.createRemoveLocalTask).toHaveBeenCalledWith(
			expect.objectContaining({ localPath: 'remote-deleted.md' }),
		)
	})

	// I3: 双方都删除了文件 → 自然清理 (不生成任何文件任务)
	it('双方都删除的文件不生成任务 (自然清理)', async () => {
		const localDB = await SyncDB.empty('device-1')
		const remoteDB = await SyncDB.empty('device-2')
		const lastSyncDB = await SyncDB.empty('device-1')
		lastSyncDB.upsertFile({
			path: 'both-deleted.md',
			mtime: 1000,
			size: 100,
			hash: 'd'.repeat(64),
			isDir: 0,
		})

		const factory = createMockTaskFactory()
		await twoWayDecider({
			settings: defaultSettings,
			localDB,
			remoteDB,
			lastSyncDB,
			remoteBaseDir: '/remote',
			taskFactory: factory,
		})

		// 不应该创建任何文件相关的任务
		expect(factory.createPushTask).not.toHaveBeenCalled()
		expect(factory.createPullTask).not.toHaveBeenCalled()
		expect(factory.createNoopTask).not.toHaveBeenCalled()
		expect(factory.createRemoveLocalTask).not.toHaveBeenCalled()
		expect(factory.createRemoveRemoteTask).not.toHaveBeenCalled()
		expect(factory.createConflictResolveTask).not.toHaveBeenCalled()
	})

	// I3: 文件名包含非法字符 → FilenameError
	it('文件名包含非法字符时生成 FilenameError 任务', async () => {
		const localDB = await SyncDB.empty('device-1')
		localDB.upsertFile({
			path: 'bad:file.md',
			mtime: 1000,
			size: 100,
			hash: 'a'.repeat(64),
			isDir: 0,
		})
		const remoteDB = await SyncDB.empty('device-2')
		const lastSyncDB = await SyncDB.empty('device-1')

		const factory = createMockTaskFactory()
		await twoWayDecider({
			settings: defaultSettings,
			localDB,
			remoteDB,
			lastSyncDB,
			remoteBaseDir: '/remote',
			taskFactory: factory,
		})

		expect(factory.createFilenameErrorTask).toHaveBeenCalledWith(
			expect.objectContaining({ localPath: 'bad:file.md' }),
		)
		expect(factory.createPushTask).not.toHaveBeenCalled()
	})

	// I3: 文件过大 → SkippedTask(FileTooLarge)
	it('文件太大时生成 SkippedTask (FileTooLarge)', async () => {
		const localDB = await SyncDB.empty('device-1')
		localDB.upsertFile({
			path: 'big-file.md',
			mtime: 1000,
			size: 2 * 1024 * 1024,
			hash: 'a'.repeat(64),
			isDir: 0,
		})
		const remoteDB = await SyncDB.empty('device-2')
		const lastSyncDB = await SyncDB.empty('device-1')

		const factory = createMockTaskFactory()
		const settings = { ...defaultSettings, skipLargeFiles: { maxSize: '1MB' } }
		await twoWayDecider({
			settings,
			localDB,
			remoteDB,
			lastSyncDB,
			remoteBaseDir: '/remote',
			taskFactory: factory,
		})

		expect(factory.createSkippedTask).toHaveBeenCalledWith(
			expect.objectContaining({
				localPath: 'big-file.md',
				reason: SKIP_REASON_FILE_TOO_LARGE,
				maxSize: 1024 * 1024,
			}),
		)
		expect(factory.createPushTask).not.toHaveBeenCalled()
	})

	// 目录测试：本地新建目录 → MkdirRemote
	it('本地新建目录应该生成 MkdirRemote 任务', async () => {
		const localDB = await SyncDB.empty('device-1')
		localDB.upsertFile({
			path: 'new-folder',
			mtime: 0,
			size: 0,
			hash: '',
			isDir: 1,
		})
		const remoteDB = await SyncDB.empty('device-2')
		const lastSyncDB = await SyncDB.empty('device-1')

		const factory = createMockTaskFactory()
		await twoWayDecider({
			settings: defaultSettings,
			localDB,
			remoteDB,
			lastSyncDB,
			remoteBaseDir: '/remote',
			taskFactory: factory,
		})

		expect(factory.createMkdirRemoteTask).toHaveBeenCalledWith(
			expect.objectContaining({ localPath: 'new-folder' }),
		)
	})

	// 目录非法字符测试
	it('目录名包含非法字符时生成 FilenameError 任务', async () => {
		const localDB = await SyncDB.empty('device-1')
		localDB.upsertFile({
			path: 'bad:folder',
			mtime: 0,
			size: 0,
			hash: '',
			isDir: 1,
		})
		const remoteDB = await SyncDB.empty('device-2')
		const lastSyncDB = await SyncDB.empty('device-1')

		const factory = createMockTaskFactory()
		await twoWayDecider({
			settings: defaultSettings,
			localDB,
			remoteDB,
			lastSyncDB,
			remoteBaseDir: '/remote',
			taskFactory: factory,
		})

		expect(factory.createFilenameErrorTask).toHaveBeenCalledWith(
			expect.objectContaining({ localPath: 'bad:folder' }),
		)
		expect(factory.createMkdirRemoteTask).not.toHaveBeenCalled()
	})

	// I2: 任务排序测试 — 删除任务（深优先）在创建目录任务（浅优先）之前
	it('任务排序: 删除任务（深优先）→ 目录任务（浅优先）→ 文件任务', async () => {
		const localDB = await SyncDB.empty('device-1')
		const remoteDB = await SyncDB.empty('device-2')
		const lastSyncDB = await SyncDB.empty('device-1')

		// 需要删除的嵌套文件 (最深)
		remoteDB.upsertFile({
			path: 'a/b/c/del.md',
			mtime: 1000,
			size: 100,
			hash: 'd'.repeat(64),
			isDir: 0,
		})
		lastSyncDB.upsertFile({
			path: 'a/b/c/del.md',
			mtime: 1000,
			size: 100,
			hash: 'd'.repeat(64),
			isDir: 0,
		})

		// 需要创建的目录 (浅层)
		localDB.upsertFile({ path: 'x', mtime: 0, size: 0, hash: '', isDir: 1 })
		localDB.upsertFile({ path: 'x/y', mtime: 0, size: 0, hash: '', isDir: 1 })

		// 普通文件
		localDB.upsertFile({
			path: 'push-me.md',
			mtime: 2000,
			size: 150,
			hash: 'new-hash'.padEnd(64, 'x'),
			isDir: 0,
		})
		remoteDB.upsertFile({
			path: 'push-me.md',
			mtime: 1000,
			size: 100,
			hash: 'old-hash'.padEnd(64, 'x'),
			isDir: 0,
		})
		lastSyncDB.upsertFile({
			path: 'push-me.md',
			mtime: 1000,
			size: 100,
			hash: 'old-hash'.padEnd(64, 'x'),
			isDir: 0,
		})

		const factory = createMockTaskFactory()
		const result = await twoWayDecider({
			settings: defaultSettings,
			localDB,
			remoteDB,
			lastSyncDB,
			remoteBaseDir: '/remote',
			taskFactory: factory,
		})

		// 按顺序检查类型
		const types = result.map((t: any) => t.type)
		const removeIdx = types.indexOf('remove-remote')
		const mkdirIdx = types.findIndex((t: string) => t === 'mkdir-remote')
		const pushIdx = types.indexOf('push')

		expect(removeIdx).toBeGreaterThanOrEqual(0)
		// 删除任务应该在目录任务之前
		expect(removeIdx).toBeLessThan(mkdirIdx)
		// 目录任务应该在文件任务之前
		expect(mkdirIdx).toBeLessThan(pushIdx)
	})

	// C4: 文件与目录类型冲突 → 抛出错误
	it('文件与目录类型冲突时抛出错误', async () => {
		const localDB = await SyncDB.empty('device-1')
		localDB.upsertFile({
			path: 'conflict-type',
			mtime: 1000,
			size: 100,
			hash: 'a'.repeat(64),
			isDir: 0,
		})
		const remoteDB = await SyncDB.empty('device-2')
		remoteDB.upsertFile({
			path: 'conflict-type',
			mtime: 0,
			size: 0,
			hash: '',
			isDir: 1,
		})
		const lastSyncDB = await SyncDB.empty('device-1')

		const factory = createMockTaskFactory()
		await expect(
			twoWayDecider({
				settings: defaultSettings,
				localDB,
				remoteDB,
				lastSyncDB,
				remoteBaseDir: '/remote',
				taskFactory: factory,
			}),
		).rejects.toThrow('type conflict')
	})
})
