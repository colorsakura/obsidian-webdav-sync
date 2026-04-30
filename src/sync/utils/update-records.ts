import { chunk, debounce, isNil } from 'lodash-es'
import { Vault } from 'obsidian'
import { emitSyncUpdateMtimeProgress } from '~/events'
import { StatModel } from '~/model/stat.model'
import type { FsWalkResult } from '~/fs/fs.interface'
import { WebDAVRemoteFileSystem } from '~/fs/webdav-remote'
import { syncRecordKV } from '~/storage'
import { blobStore } from '~/storage/blob'
import { SyncRecord } from '~/storage/sync-record'
import MkdirsRemoteTask from '~/sync/tasks/mkdirs-remote.task'
import type { BaseTask, TaskResult } from '~/sync/tasks/task.interface'
import { isMergeablePath } from '~/sync/utils/is-mergeable-path'
import { getDBKey } from '~/utils/get-db-key'
import { isSub } from '~/utils/is-sub'
import logger from '~/utils/logger'
import { sha256Hex } from '~/utils/sha256'
import { statVaultItem } from '~/utils/stat-vault-item'
import { stdRemotePath } from '~/utils/std-remote-path'
import type NutstorePlugin from '../..'
import RemoveRemoteRecursivelyTask from '../tasks/remove-remote-recursively.task'

/**
 * 批量更新同步记录的工具函数
 */
export async function updateMtimeInRecord(
	plugin: NutstorePlugin,
	vault: Vault,
	remoteBaseDir: string,
	tasks: BaseTask[],
	results: TaskResult[],
	batch_size: number,
	options?: { skipRemoteWalk?: boolean },
): Promise<void> {
	if (tasks.length === 0) {
		return
	}
	// Filter out tasks that don't need record updates
	const tasksNeedingUpdate = tasks.filter((task, idx) => {
		return results[idx]?.success && !results[idx]?.skipRecord
	})

	if (tasksNeedingUpdate.length === 0) {
		return
	}

	const syncRecord = new SyncRecord(
		getDBKey(vault.getName(), remoteBaseDir),
		syncRecordKV,
	)
	const records = await syncRecord.getRecords()

	const token = await plugin.getToken()
	const remoteFs = new WebDAVRemoteFileSystem({
		vault,
		token,
		remoteBaseDir: stdRemotePath(remoteBaseDir),
		endpoint: plugin.settings.webdavEndpoint,
	})

	let remoteEntityMap: Map<string, FsWalkResult>

	if (options?.skipRemoteWalk) {
		// 哨兵匹配时：从已执行成功的 task 和已有 records 推断远端状态
		const remoteStats = new Map<string, StatModel>()
		for (const task of tasksNeedingUpdate) {
			const result = results[tasks.indexOf(task)]
			if (result?.success) {
				if (task instanceof MkdirsRemoteTask) {
					// MkdirsRemoteTask 创建了多个父子目录，需全部记录
					for (const pathInfo of task.getAllPaths()) {
						const localStat = await statVaultItem(vault, pathInfo.localPath)
						if (localStat) {
							remoteStats.set(pathInfo.localPath, localStat)
						}
					}
				} else {
					const localStat = await statVaultItem(vault, task.localPath)
					if (localStat) {
						remoteStats.set(task.localPath, localStat)
					}
				}
			}
		}
		for (const [path, record] of records) {
			if (!remoteStats.has(path) && !record.remote.isDeleted) {
				remoteStats.set(path, record.remote)
			}
		}
		remoteEntityMap = new Map(
			Array.from(remoteStats.entries()).map(([path, stat]) => [
				path,
				{ stat, ignored: false },
			]),
		)
	} else {
		await remoteFs.clearTraversalCache()
		const latestRemoteEntities = await remoteFs.walk()
		remoteEntityMap = new Map(latestRemoteEntities.map((e) => [e.stat.path, e]))
	}
	const startAt = Date.now()
	let completedCount = 0
	let successfulTasksCount = 0

	const debouncedSetRecords = debounce(
		(records) => syncRecord.setRecords(records),
		3000,
		{
			trailing: true,
			leading: false,
		},
	)

	// Expand MkdirsRemoteTask into multiple update operations
	const expandedTasks: Array<{ task: BaseTask; localPath: string }> = []
	for (const task of tasksNeedingUpdate) {
		if (task instanceof MkdirsRemoteTask) {
			// Add main path and all additional paths
			const allPaths = task.getAllPaths()
			for (const pathInfo of allPaths) {
				expandedTasks.push({ task, localPath: pathInfo.localPath })
			}
		} else {
			expandedTasks.push({ task, localPath: task.localPath })
		}
	}

	const taskChunks = chunk(expandedTasks, batch_size)

	for (const taskChunk of taskChunks) {
		const batch = taskChunk.map(async ({ task, localPath }) => {
			try {
				const remote = remoteEntityMap.get(localPath)
				const local = await statVaultItem(vault, localPath)

				if (task instanceof RemoveRemoteRecursivelyTask) {
					for (const k of records.keys()) {
						if (isSub(localPath, k)) {
							records.delete(k)
						}
					}
					records.delete(localPath)
					return
				}

				if (!local && !remote) {
					records.delete(localPath)
					return
				}
				if (!local || !remote) {
					return
				}
				// Calculate base for file content
				let base: { key: string } | undefined
				let baseKey: string | undefined
				if (!local.isDir) {
					const buffer = await vault.adapter.readBinary(localPath)
					const isMergeable = isMergeablePath(localPath)
					if (!isMergeable) {
						baseKey = await sha256Hex(buffer)
					} else {
						const { key } = await blobStore.store(buffer)
						baseKey = key
					}
				}
				base = isNil(baseKey) ? undefined : { key: baseKey }

				records.set(localPath, {
					remote: remote.stat,
					local,
					base,
				})
				successfulTasksCount++
			} catch (e) {
				logger.error(
					'updateMtimeInRecord',
					{
						errorName: (e as Error).name,
						errorMsg: (e as Error).message,
					},
					task.toJSON(),
				)
			} finally {
				completedCount++
			}
		})
		await Promise.all(batch)
		emitSyncUpdateMtimeProgress(expandedTasks.length, completedCount)
		debouncedSetRecords(records)
	}

	await debouncedSetRecords.flush()

	logger.debug(`Records saving completed`, {
		recordsSize: records.size,
		elapsedMs: Date.now() - startAt,
	})
}
