import { describe, it, expect } from 'vitest'
import { twoWayDecider } from '../decision/two-way.decider.function'
import { SyncDB } from '../db/sync-db'
import type {
	SyncDecisionInput,
	TaskFactory,
	TaskOptions,
	PullTaskOptions,
	ConflictTaskOptions,
	SkippedTaskOptions,
} from '../decision/sync-decision.interface'
import type { BaseTask } from '../tasks/task.interface'
import PushTask from '../tasks/push.task'
import PullTask from '../tasks/pull.task'
import ConflictResolveTask from '../tasks/conflict-resolve.task'
import NoopTask from '../tasks/noop.task'
import RemoveLocalTask from '../tasks/remove-local.task'
import RemoveRemoteTask from '../tasks/remove-remote.task'
import MkdirRemoteTask from '../tasks/mkdir-remote.task'
import MkdirLocalTask from '../tasks/mkdir-local.task'
import { ConflictStrategy } from '../tasks/conflict-strategy'
import type { SyncMode } from '~/settings'

// Real task factory — uses actual task classes with mock vault/webdav
function createRealTaskFactory(): TaskFactory {
	const commonOpts = {
		vault: {} as any,
		webdav: {} as any,
		remoteBaseDir: '/remote',
	}

	return {
		createPullTask: (o: PullTaskOptions) =>
			new PullTask({ ...commonOpts, ...o }),
		createPushTask: (o: TaskOptions) => new PushTask({ ...commonOpts, ...o }),
		createConflictResolveTask: (o: ConflictTaskOptions) =>
			new ConflictResolveTask({ ...commonOpts, ...o }),
		createNoopTask: (o: TaskOptions) => new NoopTask({ ...commonOpts, ...o }),
		createRemoveLocalTask: (o: TaskOptions) =>
			new RemoveLocalTask({ ...commonOpts, ...o }),
		createRemoveRemoteTask: (o: TaskOptions) =>
			new RemoveRemoteTask({ ...commonOpts, ...o }),
		createMkdirLocalTask: (o: TaskOptions) =>
			new MkdirLocalTask({ ...commonOpts, ...o }),
		createMkdirRemoteTask: (o: TaskOptions) =>
			new MkdirRemoteTask({ ...commonOpts, ...o }),
		createCleanRecordTask: (o: TaskOptions) => {
			// Dynamic import to avoid potential circular dependency
			const CleanRecordTask = require('../tasks/clean-record.task').default
			return new CleanRecordTask({ ...commonOpts, ...o })
		},
		createFilenameErrorTask: (o: TaskOptions) => {
			// Dynamic import to avoid potential circular dependency
			const FilenameErrorTask = require('../tasks/filename-error.task').default
			return new FilenameErrorTask({ ...commonOpts, ...o })
		},
		createSkippedTask: (o: SkippedTaskOptions) => {
			// Dynamic import to avoid potential circular dependency
			const SkippedTask = require('../tasks/skipped.task').default
			return new SkippedTask({ ...commonOpts, ...o })
		},
	}
}

const defaultSettings = {
	skipLargeFiles: { maxSize: '' },
	conflictStrategy: ConflictStrategy.LatestTimeStamp,
	useGitStyle: false,
	syncMode: 'strict' as SyncMode,
	configDir: '.obsidian',
	encryptionEnabled: false,
}

async function makeInput(
	localDB: SyncDB,
	remoteDB: SyncDB,
	lastSyncDB: SyncDB,
): Promise<SyncDecisionInput> {
	return {
		settings: defaultSettings,
		localDB,
		remoteDB,
		lastSyncDB,
		remoteBaseDir: '/remote',
		taskFactory: createRealTaskFactory(),
	}
}

function makeHash(seed: string): string {
	return (seed + '0'.repeat(64)).slice(0, 64)
}

describe('Sync Flow Integration (DB-based)', () => {
	it('首次同步：100 个本地文件 → 全部 Push', async () => {
		const localDB = await SyncDB.empty('device-1')
		for (let i = 0; i < 100; i++) {
			localDB.upsertFile({
				path: `note-${i}.md`,
				mtime: 1000 + i,
				size: 100,
				hash: makeHash(`local-${i}`),
				isDir: 0,
			})
		}
		const remoteDB = await SyncDB.empty('remote')
		const lastSyncDB = await SyncDB.empty('device-1')

		const tasks = await twoWayDecider(
			await makeInput(localDB, remoteDB, lastSyncDB),
		)

		const pushTasks = tasks.filter((t) => t instanceof PushTask)
		expect(pushTasks).toHaveLength(100)
		const otherTasks = tasks.filter((t) => !(t instanceof PushTask))
		expect(otherTasks).toHaveLength(0)
	})

	it('增量同步：修改 5 + 新增 3 + 删除 2', async () => {
		const localDB = await SyncDB.empty('device-1')
		const remoteDB = await SyncDB.empty('remote')
		const lastSyncDB = await SyncDB.empty('device-1')

		// Baseline: 10 files in lastSyncDB and remoteDB
		for (let i = 0; i < 10; i++) {
			const path = `doc-${i}.md`
			const hash = makeHash(`v1-${i}`)
			lastSyncDB.upsertFile({ path, mtime: 1000, size: 100, hash, isDir: 0 })
			remoteDB.upsertFile({ path, mtime: 1000, size: 100, hash, isDir: 0 })
		}

		// Local: modify 5 files (0-4), keep 3 unchanged (7-9), delete 2 (5-6 absent)
		for (let i = 0; i < 5; i++) {
			localDB.upsertFile({
				path: `doc-${i}.md`,
				mtime: 2000,
				size: 150,
				hash: makeHash(`v2-${i}`),
				isDir: 0,
			})
		}
		for (let i = 7; i < 10; i++) {
			localDB.upsertFile({
				path: `doc-${i}.md`,
				mtime: 1000,
				size: 100,
				hash: makeHash(`v1-${i}`),
				isDir: 0,
			})
		}
		// New files (10-12)
		for (let i = 10; i < 13; i++) {
			localDB.upsertFile({
				path: `doc-${i}.md`,
				mtime: 1000,
				size: 100,
				hash: makeHash(`new-${i}`),
				isDir: 0,
			})
		}

		const tasks = await twoWayDecider(
			await makeInput(localDB, remoteDB, lastSyncDB),
		)

		const pushTasks = tasks.filter((t) => t instanceof PushTask)
		const removeRemoteTasks = tasks.filter((t) => t instanceof RemoveRemoteTask)
		const noopTasks = tasks.filter((t) => t instanceof NoopTask)

		// 5 modified + 3 new = 8 push
		expect(pushTasks).toHaveLength(8)
		// 2 deleted locally (files 5 and 6, remote unchanged → RemoveRemote)
		expect(removeRemoteTasks).toHaveLength(2)
		// 3 unchanged (7, 8, 9)
		expect(noopTasks).toHaveLength(3)
	})

	it('冲突：双方同时编辑同一文件', async () => {
		const localDB = await SyncDB.empty('device-1')
		const remoteDB = await SyncDB.empty('device-2')
		const lastSyncDB = await SyncDB.empty('device-1')

		const path = 'conflict.md'
		lastSyncDB.upsertFile({
			path,
			mtime: 1000,
			size: 100,
			hash: makeHash('base'),
			isDir: 0,
		})
		localDB.upsertFile({
			path,
			mtime: 2000,
			size: 120,
			hash: makeHash('local-edit'),
			isDir: 0,
		})
		remoteDB.upsertFile({
			path,
			mtime: 3000,
			size: 130,
			hash: makeHash('remote-edit'),
			isDir: 0,
		})

		const tasks = await twoWayDecider(
			await makeInput(localDB, remoteDB, lastSyncDB),
		)

		const conflicts = tasks.filter((t) => t instanceof ConflictResolveTask)
		expect(conflicts).toHaveLength(1)
		expect(conflicts[0].localPath).toBe(path)
	})

	it('双方删除：自然清理，无任务', async () => {
		const localDB = await SyncDB.empty('device-1')
		const remoteDB = await SyncDB.empty('device-2')
		const lastSyncDB = await SyncDB.empty('device-1')

		lastSyncDB.upsertFile({
			path: 'gone.md',
			mtime: 1000,
			size: 100,
			hash: makeHash('old'),
			isDir: 0,
		})

		const tasks = await twoWayDecider(
			await makeInput(localDB, remoteDB, lastSyncDB),
		)

		// No file tasks for files deleted on both sides
		const fileTasks = tasks.filter(
			(t) => !(t instanceof NoopTask) && t.localPath === 'gone.md',
		)
		expect(fileTasks).toHaveLength(0)
	})

	it('目录同步：本地新建目录 → MkdirRemote 任务', async () => {
		const localDB = await SyncDB.empty('device-1')
		const remoteDB = await SyncDB.empty('remote')
		const lastSyncDB = await SyncDB.empty('device-1')

		// New directories
		localDB.upsertFile({
			path: 'new-folder',
			mtime: 0,
			size: 0,
			hash: '',
			isDir: 1,
		})
		localDB.upsertFile({
			path: 'new-folder/sub',
			mtime: 0,
			size: 0,
			hash: '',
			isDir: 1,
		})

		const tasks = await twoWayDecider(
			await makeInput(localDB, remoteDB, lastSyncDB),
		)

		const mkdirTasks = tasks.filter((t) => t instanceof MkdirRemoteTask)
		expect(mkdirTasks).toHaveLength(2)
		const paths = mkdirTasks.map((t) => t.localPath)
		expect(paths).toContain('new-folder')
		expect(paths).toContain('new-folder/sub')
	})

	it('空同步：所有文件一致 → 全部 Noop', async () => {
		const localDB = await SyncDB.empty('device-1')
		const remoteDB = await SyncDB.empty('device-2')
		const lastSyncDB = await SyncDB.empty('device-1')

		for (let i = 0; i < 10; i++) {
			const file = {
				path: `file-${i}.md`,
				mtime: 1000,
				size: 100,
				hash: makeHash(`h-${i}`),
				isDir: 0 as const,
			}
			localDB.upsertFile(file)
			remoteDB.upsertFile(file)
			lastSyncDB.upsertFile(file)
		}

		const tasks = await twoWayDecider(
			await makeInput(localDB, remoteDB, lastSyncDB),
		)

		const noopTasks = tasks.filter((t) => t instanceof NoopTask)
		expect(noopTasks).toHaveLength(10)
		const otherTasks = tasks.filter((t) => !(t instanceof NoopTask))
		expect(otherTasks).toHaveLength(0)
	})
})
