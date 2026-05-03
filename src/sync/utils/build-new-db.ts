import { SyncDB } from '../db/sync-db'
import type { BaseTask, TaskResult } from '../tasks/task.interface'

/**
 * Build a new SyncDB from the local DB and task execution results.
 * This becomes the next lastSyncDB and gets uploaded as remoteDB.
 *
 * For each task:
 * - Successful Push/Pull: file exists locally, keep in DB
 * - Successful RemoveRemote: remote file deleted, remove from DB
 * - Successful RemoveLocal: local file deleted, remove from DB
 * - Successful Mkdir: directory exists, keep in DB
 * - Noop/Conflict: unchanged, keep in DB
 */
export async function buildNewDB(
  localDB: SyncDB,
  tasks: BaseTask[],
  results: TaskResult[],
): Promise<SyncDB> {
  // Start with a copy of localDB (represents current local state)
  const buffer = localDB.toBuffer()
  const newDB = await SyncDB.fromBuffer(buffer)

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]
    const result = results[i]
    if (!result?.success) continue

    const taskName = task.constructor.name
    const path = task.remotePath || task.localPath

    if (taskName.includes('RemoveLocal') || taskName.includes('RemoveRemote')) {
      newDB.deleteFile(path)
    }
    // Push/Pull/Noop/Conflict/Mkdir — the file/dir is already in localDB,
    // so it's already in newDB (we copied from localDB)
  }

  // Bump version
  const newVersion = localDB.version + 1
  newDB.setMeta('version', String(newVersion))
  newDB.setMeta('updated_at', String(Date.now()))

  return newDB
}
