import { sha256Hex } from '~/utils/sha256'
import { SyncDB } from '../db/sync-db'
import type { BaseTask, TaskResult } from '../tasks/task.interface'

/**
 * Build a new SyncDB from the local DB and task execution results.
 * This becomes the next lastSyncDB and gets uploaded as remoteDB.
 *
 * For each task:
 * - Successful Pull: re-read local file, compute hash, upsert into newDB
 * - Successful MkdirLocal: upsert directory into newDB (not in localDB pre-scan)
 * - Successful RemoveRemote: remote file deleted, remove from DB
 * - Successful RemoveLocal: local file deleted, remove from DB
 * - Successful Push/Noop/Conflict/MkdirRemote: already in newDB (from localDB copy)
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
		} else if (taskName.includes('Pull')) {
			// After a successful Pull, the local file has changed (downloaded from remote).
			// The hash in newDB (copied from localDB, which was scanned BEFORE task
			// execution) is stale. Re-read the file to get the correct hash.
			try {
				const content = await task.vault.adapter.readBinary(task.localPath)
				const hash = await sha256Hex(content)
				const stat = await task.vault.adapter.stat(task.localPath)
				newDB.upsertFile({
					path: task.localPath,
					mtime: stat?.mtime ?? 0,
					size: stat?.size ?? 0,
					hash,
					isDir: 0,
					firstSeenAt: 0,
					contentChangedAt: 0,
					lastSyncedAt: 0,
				})
			} catch {
				// If we can't read the file after Pull (unlikely), keep the stale entry
				// and let the next sync detect the discrepancy.
			}
		} else if (taskName.includes('MkdirLocal')) {
			// After a successful MkdirLocal, the directory was created locally.
			// It's not in localDB (which was scanned BEFORE task execution), so
			// add it to newDB explicitly.
			newDB.upsertFile({
				path: task.localPath,
				mtime: 0,
				size: 0,
				hash: '',
				isDir: 1,
				firstSeenAt: 0,
				contentChangedAt: 0,
				lastSyncedAt: 0,
			})
		}
		// Push/Noop/Conflict/MkdirRemote — the file/dir is already in localDB,
		// so it's already in newDB (we copied from localDB). No update needed.
	}

	// Bump version
	const newVersion = localDB.version + 1
	newDB.setMeta('version', String(newVersion))
	newDB.setMeta('updated_at', String(Date.now()))

	return newDB
}
