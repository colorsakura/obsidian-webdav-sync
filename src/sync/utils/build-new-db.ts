import { sha256Hex } from '~/utils/sha256'
import { SyncDB } from '../db/sync-db'
import type { BaseTask, TaskResult } from '../tasks/task.interface'

/**
 * Build a new SyncDB from the local DB and task execution results.
 * This becomes the next lastSyncDB and gets uploaded as remoteDB.
 *
 * Starts from the downloaded remoteDB to preserve the remote state.
 * For successful tasks, updates the entry to reflect the local file state.
 * For failed tasks, keeps the remoteDB entry so the next sync detects
 * the discrepancy instead of treating it as already-synced.
 */
export async function buildNewDB(
	localDB: SyncDB,
	tasks: BaseTask[],
	results: TaskResult[],
	remoteDB: SyncDB,
): Promise<SyncDB> {
	const buffer = remoteDB.toBuffer()
	const newDB = await SyncDB.fromBuffer(buffer)

	for (let i = 0; i < tasks.length; i++) {
		const task = tasks[i]
		const result = results[i]
		const path = task.remotePath || task.localPath

		if (!result?.success) {
			// 任务失败：回退为 remoteDB 条目，避免本地旧 hash 污染同步状态
			const remoteEntry = remoteDB.getFile(path)
			if (remoteEntry) {
				newDB.upsertFile(remoteEntry)
			} else {
				newDB.deleteFile(path)
			}
			continue
		}

		const taskName = task.constructor.name
		const isRemove =
			taskName.includes('RemoveLocal') ||
			taskName.includes('RemoveRemote') ||
			taskName.includes('CleanRecord')
		const isPull = taskName.includes('Pull')

		if (isRemove) {
			newDB.deleteFile(path)
		} else if (isPull) {
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
				})
			} catch {
				// 无法读取文件，保留 remoteDB 条目让下次同步重试
			}
		} else {
			// Push/Noop/Conflict/Mkdir — 任务成功，local 状态即为同步后的正确状态
			const localEntry = localDB.getFile(path)
			if (localEntry) {
				newDB.upsertFile(localEntry)
			}
		}
	}

	// Bump version
	const newVersion = localDB.version + 1
	newDB.setMeta('version', String(newVersion))
	newDB.setMeta('updated_at', String(Date.now()))

	return newDB
}
