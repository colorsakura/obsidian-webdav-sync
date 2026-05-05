import { sha256Hex } from '~/utils/sha256'
import { SyncDB } from '../db/sync-db'
import type { BaseTask, TaskResult } from '../tasks/task.interface'

export async function buildNewDB(
	localDB: SyncDB,
	remoteDB: SyncDB,
	tasks: BaseTask[],
	results: TaskResult[],
): Promise<SyncDB> {
	// Start from remoteDB to preserve shared state (meta/devices/sync_sessions)
	const remoteFiles = remoteDB.getAllFiles()
	const hasRemoteState = remoteFiles.length > 0

	let newDB: SyncDB
	if (hasRemoteState) {
		const buffer = remoteDB.toBuffer()
		newDB = await SyncDB.fromBuffer(buffer)

		// Merge localDB file entries into newDB
		for (const f of localDB.getAllFiles()) {
			const existing = newDB.getFile(f.path)
			if (existing) {
				newDB.upsertFile({
					...f,
					firstSeenAt: existing.firstSeenAt || f.firstSeenAt,
				})
			} else {
				newDB.upsertFile(f)
			}
		}

		// Remove files that no longer exist locally
		const localPaths = new Set(localDB.getAllFiles().map((f) => f.path))
		for (const p of newDB.getAllPaths()) {
			if (!localPaths.has(p)) {
				newDB.deleteFile(p)
			}
		}
	} else {
		const buffer = localDB.toBuffer()
		newDB = await SyncDB.fromBuffer(buffer)
	}

	// Apply task execution results
	for (let i = 0; i < tasks.length; i++) {
		const task = tasks[i]
		const result = results[i]
		if (!result?.success) continue

		const taskName = task.constructor.name
		const path = task.remotePath || task.localPath
		const now = Date.now()

		if (taskName.includes('RemoveLocal') || taskName.includes('RemoveRemote')) {
			newDB.deleteFile(path)
		} else if (taskName.includes('Pull')) {
			try {
				const content = await task.vault.adapter.readBinary(task.localPath)
				const hash = await sha256Hex(content)
				const stat = await task.vault.adapter.stat(task.localPath)
				const existing = newDB.getFile(task.localPath)
				newDB.upsertFile({
					path: task.localPath,
					mtime: stat?.mtime ?? 0,
					size: stat?.size ?? 0,
					hash,
					isDir: 0,
					firstSeenAt: existing?.firstSeenAt ?? now,
					contentChangedAt: now,
					lastSyncedAt: now,
				})
			} catch {
				// If we can't read the file after Pull, keep the stale entry
			}
		} else if (taskName.includes('Push') || taskName.includes('ConflictResolve')) {
			const existing = newDB.getFile(path)
			if (existing) {
				newDB.upsertFile({
					...existing,
					lastSyncedAt: now,
				})
			}
		} else if (taskName.includes('MkdirLocal')) {
			newDB.upsertFile({
				path: task.localPath,
				mtime: 0,
				size: 0,
				hash: '',
				isDir: 1,
				firstSeenAt: now,
				contentChangedAt: 0,
				lastSyncedAt: now,
			})
		} else if (taskName.includes('Noop')) {
			const existing = newDB.getFile(path)
			if (existing) {
				newDB.upsertFile({
					...existing,
					lastSyncedAt: now,
				})
			}
		}
	}

	// Bump version
	const prevVersion = remoteDB.version
	const newVersion = (isNaN(prevVersion) ? 1 : prevVersion) + 1
	newDB.setMeta('version', String(newVersion))
	newDB.setMeta('updated_at', String(Date.now()))

	return newDB
}
