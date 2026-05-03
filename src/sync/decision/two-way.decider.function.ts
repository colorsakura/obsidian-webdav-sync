import { parse as bytesParse } from 'bytes-iec'
import logger from '~/utils/logger'
import { ConflictStrategy } from '../tasks/conflict-strategy'
import type { BaseTask } from '../tasks/task.interface'
import type { DBFile } from '../db/sync-db'
import type { SyncDecisionInput } from './sync-decision.interface'

function pickConflictStrategy(
  path: string,
  configDir: string,
  userStrategy: ConflictStrategy,
): ConflictStrategy {
  if (path === configDir || path.startsWith(configDir + '/')) {
    return ConflictStrategy.LatestTimeStamp
  }
  return userStrategy
}

export async function twoWayDecider(input: SyncDecisionInput): Promise<BaseTask[]> {
  const { settings, localDB, remoteDB, lastSyncDB, remoteBaseDir, taskFactory } = input

  let maxFileSize = Infinity
  const maxFileSizeStr = settings.skipLargeFiles.maxSize.trim()
  if (maxFileSizeStr !== '') {
    maxFileSize = bytesParse(maxFileSizeStr, { mode: 'jedec' }) ?? Infinity
  }

  const localFiles = new Map(localDB.getAllFiles().map(f => [f.path, f]))
  const remoteFiles = new Map(remoteDB.getAllFiles().map(f => [f.path, f]))
  const lastSyncFiles = new Map(lastSyncDB.getAllFiles().map(f => [f.path, f]))

  const allPaths = new Set([
    ...localFiles.keys(),
    ...remoteFiles.keys(),
    ...lastSyncFiles.keys(),
  ])

  // Separate files and directories
  const filePaths = [...allPaths].filter(p => {
    const l = localFiles.get(p), r = remoteFiles.get(p), b = lastSyncFiles.get(p)
    return !(l?.isDir || r?.isDir || b?.isDir)
  })
  const dirPaths = [...allPaths].filter(p => {
    const l = localFiles.get(p), r = remoteFiles.get(p), b = lastSyncFiles.get(p)
    return (l?.isDir || r?.isDir || b?.isDir)
  })

  const tasks: BaseTask[] = []
  const opts = (path: string) => ({ remotePath: path, localPath: path, remoteBaseDir })

  // File decisions based on hash comparison
  for (const p of filePaths) {
    const local = localFiles.get(p)
    const remote = remoteFiles.get(p)
    const last = lastSyncFiles.get(p)

    if (last) {
      // Has history → three-way comparison
      const localChanged = local ? local.hash !== last.hash : true // deleted locally = changed
      const remoteChanged = remote ? remote.hash !== last.hash : true

      if (local && remote) {
        if (localChanged && remoteChanged) {
          tasks.push(taskFactory.createConflictResolveTask({
            ...opts(p),
            localStat: toStat(local),
            remoteStat: toStat(remote),
            strategy: pickConflictStrategy(p, settings.configDir, settings.conflictStrategy),
            useGitStyle: settings.useGitStyle,
          }))
        } else if (localChanged) {
          tasks.push(taskFactory.createPushTask(opts(p)))
        } else if (remoteChanged) {
          tasks.push(taskFactory.createPullTask({ ...opts(p), remoteSize: remote.size }))
        } else {
          tasks.push(taskFactory.createNoopTask(opts(p)))
        }
      } else if (local && !remote) {
        // Remote was deleted, local exists
        if (!localChanged) {
          // Local unchanged → propagate remote deletion
          tasks.push(taskFactory.createRemoveLocalTask(opts(p)))
        } else {
          // Local changed → push new version
          tasks.push(taskFactory.createPushTask(opts(p)))
        }
      } else if (!local && remote) {
        // Local was deleted, remote exists
        if (!remoteChanged) {
          // Remote unchanged → propagate local deletion
          tasks.push(taskFactory.createRemoveRemoteTask(opts(p)))
        } else {
          // Remote changed → pull new version
          tasks.push(taskFactory.createPullTask({ ...opts(p), remoteSize: remote.size }))
        }
      }
      // !local && !remote: both deleted → natural cleanup (not in new DB)
    } else {
      // No history → two-way comparison
      if (local && remote) {
        if (local.hash !== remote.hash) {
          tasks.push(taskFactory.createConflictResolveTask({
            ...opts(p),
            localStat: toStat(local),
            remoteStat: toStat(remote),
            strategy: pickConflictStrategy(p, settings.configDir, settings.conflictStrategy),
            useGitStyle: settings.useGitStyle,
          }))
        } else {
          tasks.push(taskFactory.createNoopTask(opts(p)))
        }
      } else if (local && !remote) {
        tasks.push(taskFactory.createPushTask(opts(p)))
      } else if (!local && remote) {
        tasks.push(taskFactory.createPullTask({ ...opts(p), remoteSize: remote.size }))
      }
    }
  }

  // Directory decisions
  for (const p of dirPaths) {
    const local = localFiles.get(p)
    const remote = remoteFiles.get(p)
    const last = lastSyncFiles.get(p)

    if (local && remote) {
      tasks.push(taskFactory.createNoopTask(opts(p)))
    } else if (local && !remote) {
      tasks.push(taskFactory.createMkdirRemoteTask(opts(p)))
    } else if (!local && remote) {
      tasks.push(taskFactory.createMkdirLocalTask(opts(p)))
    }
    // If neither exists (in last but not in either), it naturally disappears
  }

  return tasks
}

function toStat(f: DBFile): { mtime: number; size: number; path: string; basename: string; isDir: false; isDeleted: boolean } {
  const parts = f.path.split('/')
  return {
    mtime: f.mtime, size: f.size, path: f.path,
    basename: parts[parts.length - 1], isDir: false, isDeleted: false,
  }
}
