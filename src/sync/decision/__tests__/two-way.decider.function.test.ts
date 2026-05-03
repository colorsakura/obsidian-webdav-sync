import { describe, it, expect, vi } from 'vitest'
import { twoWayDecider } from '../two-way.decider.function'
import { SyncDB } from '../../db/sync-db'
import type { SyncDecisionInput, TaskFactory } from '../sync-decision.interface'
import type { BaseTask } from '../../tasks/task.interface'
import type { SyncMode } from '~/settings'

function createMockTaskFactory(): TaskFactory {
  const createTask = (type: string) => vi.fn().mockImplementation((opts: any) => ({
    type,
    options: opts,
    exec: async () => ({ success: true }),
    localPath: opts.localPath,
    remotePath: opts.remotePath,
  } as any as BaseTask))

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
    localDB.upsertFile({ path: 'new.md', mtime: 1000, size: 100, hash: 'a'.repeat(64), isDir: 0 })
    const remoteDB = await SyncDB.empty('device-2')
    const lastSyncDB = await SyncDB.empty('device-1')

    const factory = createMockTaskFactory()
    const input: SyncDecisionInput = {
      settings: defaultSettings,
      localDB, remoteDB, lastSyncDB,
      remoteBaseDir: '/remote',
      taskFactory: factory,
    }

    await twoWayDecider(input)
    expect(factory.createPushTask).toHaveBeenCalledWith(
      expect.objectContaining({ localPath: 'new.md' })
    )
  })

  it('远端新增文件应该生成 Pull 任务', async () => {
    const localDB = await SyncDB.empty('device-1')
    const remoteDB = await SyncDB.empty('device-2')
    remoteDB.upsertFile({ path: 'remote-new.md', mtime: 1000, size: 200, hash: 'b'.repeat(64), isDir: 0 })
    const lastSyncDB = await SyncDB.empty('device-1')

    const factory = createMockTaskFactory()
    await twoWayDecider({ settings: defaultSettings, localDB, remoteDB, lastSyncDB, remoteBaseDir: '/remote', taskFactory: factory })

    expect(factory.createPullTask).toHaveBeenCalledWith(
      expect.objectContaining({ remoteSize: 200 })
    )
  })

  it('hash 相同 → Noop', async () => {
    const db1 = await SyncDB.empty('device-1')
    db1.upsertFile({ path: 'same.md', mtime: 1000, size: 100, hash: 'c'.repeat(64), isDir: 0 })
    const db2 = await SyncDB.empty('device-2')
    db2.upsertFile({ path: 'same.md', mtime: 1000, size: 100, hash: 'c'.repeat(64), isDir: 0 })
    const db3 = await SyncDB.empty('device-1')
    db3.upsertFile({ path: 'same.md', mtime: 1000, size: 100, hash: 'c'.repeat(64), isDir: 0 })

    const factory = createMockTaskFactory()
    await twoWayDecider({ settings: defaultSettings, localDB: db1, remoteDB: db2, lastSyncDB: db3, remoteBaseDir: '/remote', taskFactory: factory })

    expect(factory.createNoopTask).toHaveBeenCalled()
    expect(factory.createPushTask).not.toHaveBeenCalled()
    expect(factory.createPullTask).not.toHaveBeenCalled()
  })

  it('本地修改 + 远端未改 → Push', async () => {
    const localDB = await SyncDB.empty('device-1')
    localDB.upsertFile({ path: 'edit.md', mtime: 2000, size: 150, hash: 'new-hash'.padEnd(64, 'x'), isDir: 0 })
    const remoteDB = await SyncDB.empty('device-2')
    remoteDB.upsertFile({ path: 'edit.md', mtime: 1000, size: 100, hash: 'old-hash'.padEnd(64, 'x'), isDir: 0 })
    const lastSyncDB = await SyncDB.empty('device-1')
    lastSyncDB.upsertFile({ path: 'edit.md', mtime: 1000, size: 100, hash: 'old-hash'.padEnd(64, 'x'), isDir: 0 })

    const factory = createMockTaskFactory()
    await twoWayDecider({ settings: defaultSettings, localDB, remoteDB, lastSyncDB, remoteBaseDir: '/remote', taskFactory: factory })

    expect(factory.createPushTask).toHaveBeenCalledWith(
      expect.objectContaining({ localPath: 'edit.md' })
    )
  })

  it('双方修改同文件 → Conflict', async () => {
    const localDB = await SyncDB.empty('device-1')
    localDB.upsertFile({ path: 'conflict.md', mtime: 2000, size: 150, hash: 'local-hash'.padEnd(64, 'x'), isDir: 0 })
    const remoteDB = await SyncDB.empty('device-2')
    remoteDB.upsertFile({ path: 'conflict.md', mtime: 3000, size: 160, hash: 'remote-hash'.padEnd(64, 'x'), isDir: 0 })
    const lastSyncDB = await SyncDB.empty('device-1')
    lastSyncDB.upsertFile({ path: 'conflict.md', mtime: 1000, size: 100, hash: 'base-hash'.padEnd(64, 'x'), isDir: 0 })

    const factory = createMockTaskFactory()
    await twoWayDecider({ settings: defaultSettings, localDB, remoteDB, lastSyncDB, remoteBaseDir: '/remote', taskFactory: factory })

    expect(factory.createConflictResolveTask).toHaveBeenCalledWith(
      expect.objectContaining({ localPath: 'conflict.md' })
    )
  })

  it('本地删除 + 远端未改 → RemoveRemote', async () => {
    const localDB = await SyncDB.empty('device-1')
    const remoteDB = await SyncDB.empty('device-2')
    remoteDB.upsertFile({ path: 'del.md', mtime: 1000, size: 100, hash: 'd'.repeat(64), isDir: 0 })
    const lastSyncDB = await SyncDB.empty('device-1')
    lastSyncDB.upsertFile({ path: 'del.md', mtime: 1000, size: 100, hash: 'd'.repeat(64), isDir: 0 })

    const factory = createMockTaskFactory()
    await twoWayDecider({ settings: defaultSettings, localDB, remoteDB, lastSyncDB, remoteBaseDir: '/remote', taskFactory: factory })

    expect(factory.createRemoveRemoteTask).toHaveBeenCalledWith(
      expect.objectContaining({ localPath: 'del.md' })
    )
  })
})
