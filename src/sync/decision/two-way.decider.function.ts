import { parse as bytesParse } from 'bytes-iec'
import logger from '~/utils/logger'
import { ConflictStrategy } from '../tasks/conflict-strategy'
import type { BaseTask } from '../tasks/task.interface'
import type { DBFile } from '../db/sync-db'
import type { SyncDecisionInput, TaskOptions } from './sync-decision.interface'
import { hasInvalidChar } from '~/utils/has-invalid-char'

/** Enum values from SkipReason — redefined here to avoid circular dependency via skipped.task → task.interface → get-task-name → clean-record.task */
const SKIP_REASON_FILE_TOO_LARGE = 'file-too-large'

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

function countDepth(path: string): number {
	return path.split('/').length - 1
}

/**
 * Create a SkippedTask for a file that exceeds the maximum allowed size.
 */
function createFileTooLargeTask(
	path: string,
	maxSize: number,
	taskFactory: SyncDecisionInput['taskFactory'],
	remoteBaseDir: string,
	local?: DBFile,
	remote?: DBFile,
): BaseTask {
	const base: TaskOptions = { localPath: path, remotePath: path, remoteBaseDir }
	if (local && remote) {
		return taskFactory.createSkippedTask({
			...base,
			reason: SKIP_REASON_FILE_TOO_LARGE,
			maxSize,
			localSize: local.size,
			remoteSize: remote.size,
		} as any)
	} else if (local) {
		return taskFactory.createSkippedTask({
			...base,
			reason: SKIP_REASON_FILE_TOO_LARGE,
			maxSize,
			localSize: local.size,
		} as any)
	} else {
		return taskFactory.createSkippedTask({
			...base,
			reason: SKIP_REASON_FILE_TOO_LARGE,
			maxSize,
			remoteSize: remote!.size,
		} as any)
	}
}

export async function twoWayDecider(
	input: SyncDecisionInput,
): Promise<BaseTask[]> {
	const {
		settings,
		localDB,
		remoteDB,
		lastSyncDB,
		remoteBaseDir,
		taskFactory,
	} = input

	let maxFileSize = Infinity
	const maxFileSizeStr = settings.skipLargeFiles.maxSize.trim()
	if (maxFileSizeStr !== '') {
		maxFileSize = bytesParse(maxFileSizeStr, { mode: 'jedec' }) ?? Infinity
	}

	const localFiles = new Map(localDB.getAllFiles().map((f) => [f.path, f]))
	const remoteFiles = new Map(remoteDB.getAllFiles().map((f) => [f.path, f]))
	const lastSyncFiles = new Map(
		lastSyncDB.getAllFiles().map((f) => [f.path, f]),
	)

	const allPaths = new Set([
		...localFiles.keys(),
		...remoteFiles.keys(),
		...lastSyncFiles.keys(),
	])

	// C4: Detect file-vs-directory type conflicts before processing
	for (const p of allPaths) {
		const local = localFiles.get(p)
		const remote = remoteFiles.get(p)
		const last = lastSyncFiles.get(p)
		const types = new Set<number>()
		if (local) types.add(local.isDir)
		if (remote) types.add(remote.isDir)
		if (last) types.add(last.isDir)
		if (types.size > 1) {
			throw new Error(
				`Path "${p}" type conflict: file in one database, directory in another`,
			)
		}
	}

	// Separate files and directories
	const filePaths = [...allPaths].filter((p) => {
		const l = localFiles.get(p),
			r = remoteFiles.get(p),
			b = lastSyncFiles.get(p)
		return !(l?.isDir || r?.isDir || b?.isDir)
	})
	const dirPaths = [...allPaths].filter((p) => {
		const l = localFiles.get(p),
			r = remoteFiles.get(p),
			b = lastSyncFiles.get(p)
		return l?.isDir || r?.isDir || b?.isDir
	})

	const tasks: BaseTask[] = []
	const opts = (path: string): TaskOptions => ({
		remotePath: path,
		localPath: path,
		remoteBaseDir,
	})

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
					// Both sides changed → conflict
					// C1: Check maxFileSize
					if (local.size > maxFileSize || remote.size > maxFileSize) {
						logger.debug(`Skip (too large) — "${p}"`)
						tasks.push(
							createFileTooLargeTask(
								p,
								maxFileSize,
								taskFactory,
								remoteBaseDir,
								local,
								remote,
							),
						)
					} else {
						// C3: Check invalid chars for remote-bound operation
						if (hasInvalidChar(p)) {
							logger.debug(`Filename error — "${p}"`)
							tasks.push(taskFactory.createFilenameErrorTask(opts(p)))
						} else {
							logger.debug(`Conflict — "${p}" (both modified)`)
							tasks.push(
								taskFactory.createConflictResolveTask({
									...opts(p),
									localStat: toStat(local),
									remoteStat: toStat(remote),
									strategy: pickConflictStrategy(
										p,
										settings.configDir,
										settings.conflictStrategy,
									),
									useGitStyle: settings.useGitStyle,
								}),
							)
						}
					}
				} else if (localChanged) {
					// C1: Check maxFileSize
					if (local.size > maxFileSize) {
						logger.debug(`Skip (too large) — "${p}"`)
						tasks.push(
							createFileTooLargeTask(
								p,
								maxFileSize,
								taskFactory,
								remoteBaseDir,
								local,
								remote,
							),
						)
					} else {
						// C3: Check invalid chars for push
						if (hasInvalidChar(p)) {
							logger.debug(`Filename error — "${p}"`)
							tasks.push(taskFactory.createFilenameErrorTask(opts(p)))
						} else {
							logger.debug(`Push — "${p}" (local modified)`)
							tasks.push(taskFactory.createPushTask(opts(p)))
						}
					}
				} else if (remoteChanged) {
					// C1: Check maxFileSize
					if (remote.size > maxFileSize) {
						logger.debug(`Skip (too large) — "${p}"`)
						tasks.push(
							createFileTooLargeTask(
								p,
								maxFileSize,
								taskFactory,
								remoteBaseDir,
								undefined,
								remote,
							),
						)
					} else {
						logger.debug(`Pull — "${p}" (remote modified)`)
						tasks.push(
							taskFactory.createPullTask({
								...opts(p),
								remoteSize: remote.size,
							}),
						)
					}
				} else {
					logger.debug(`Noop — "${p}" (no changes)`)
					tasks.push(taskFactory.createNoopTask(opts(p)))
				}
			} else if (local && !remote) {
				// Remote was deleted, local exists
				if (!localChanged) {
					// Local unchanged → propagate remote deletion
					logger.debug(`Remove local — "${p}" (remote deleted)`)
					tasks.push(taskFactory.createRemoveLocalTask(opts(p)))
				} else {
					// Local changed → push new version
					// C1: Check maxFileSize
					if (local.size > maxFileSize) {
						logger.debug(`Skip (too large) — "${p}"`)
						tasks.push(
							createFileTooLargeTask(
								p,
								maxFileSize,
								taskFactory,
								remoteBaseDir,
								local,
							),
						)
					} else {
						// C3: Check invalid chars
						if (hasInvalidChar(p)) {
							logger.debug(`Filename error — "${p}"`)
							tasks.push(taskFactory.createFilenameErrorTask(opts(p)))
						} else {
							logger.debug(`Push — "${p}" (local modified, remote deleted)`)
							tasks.push(taskFactory.createPushTask(opts(p)))
						}
					}
				}
			} else if (!local && remote) {
				// Local was deleted, remote exists
				if (!remoteChanged) {
					// Remote unchanged → propagate local deletion
					logger.debug(`Remove remote — "${p}" (local deleted)`)
					tasks.push(taskFactory.createRemoveRemoteTask(opts(p)))
				} else {
					// Remote changed → pull new version
					// C1: Check maxFileSize
					if (remote.size > maxFileSize) {
						logger.debug(`Skip (too large) — "${p}"`)
						tasks.push(
							createFileTooLargeTask(
								p,
								maxFileSize,
								taskFactory,
								remoteBaseDir,
								undefined,
								remote,
							),
						)
					} else {
						logger.debug(`Pull — "${p}" (remote modified, local deleted)`)
						tasks.push(
							taskFactory.createPullTask({
								...opts(p),
								remoteSize: remote.size,
							}),
						)
					}
				}
			}
			// !local && !remote: both deleted → natural cleanup (not in new DB)
			// I3 coverage: this is the "both-deleted" scenario — no task needed
		} else {
			// No history → two-way comparison
			if (local && remote) {
				if (local.hash !== remote.hash) {
					// C1: Check maxFileSize
					if (local.size > maxFileSize || remote.size > maxFileSize) {
						logger.debug(`Skip (too large) — "${p}"`)
						tasks.push(
							createFileTooLargeTask(
								p,
								maxFileSize,
								taskFactory,
								remoteBaseDir,
								local,
								remote,
							),
						)
					} else {
						// C3: Check invalid chars
						if (hasInvalidChar(p)) {
							logger.debug(`Filename error — "${p}"`)
							tasks.push(taskFactory.createFilenameErrorTask(opts(p)))
						} else {
							logger.debug(`Conflict — "${p}" (no sync history)`)
							tasks.push(
								taskFactory.createConflictResolveTask({
									...opts(p),
									localStat: toStat(local),
									remoteStat: toStat(remote),
									strategy: pickConflictStrategy(
										p,
										settings.configDir,
										settings.conflictStrategy,
									),
									useGitStyle: settings.useGitStyle,
								}),
							)
						}
					}
				} else {
					logger.debug(`Noop — "${p}" (same hash)`)
					tasks.push(taskFactory.createNoopTask(opts(p)))
				}
			} else if (local && !remote) {
				// C1: Check maxFileSize
				if (local.size > maxFileSize) {
					logger.debug(`Skip (too large) — "${p}"`)
					tasks.push(
						createFileTooLargeTask(
							p,
							maxFileSize,
							taskFactory,
							remoteBaseDir,
							local,
						),
					)
				} else {
					// C3: Check invalid chars
					if (hasInvalidChar(p)) {
						logger.debug(`Filename error — "${p}"`)
						tasks.push(taskFactory.createFilenameErrorTask(opts(p)))
					} else {
						logger.debug(`Push — "${p}" (new file, no history)`)
						tasks.push(taskFactory.createPushTask(opts(p)))
					}
				}
			} else if (!local && remote) {
				// C1: Check maxFileSize
				if (remote.size > maxFileSize) {
					logger.debug(`Skip (too large) — "${p}"`)
					tasks.push(
						createFileTooLargeTask(
							p,
							maxFileSize,
							taskFactory,
							remoteBaseDir,
							undefined,
							remote,
						),
					)
				} else {
					logger.debug(`Pull — "${p}" (new file, no history)`)
					tasks.push(
						taskFactory.createPullTask({ ...opts(p), remoteSize: remote.size }),
					)
				}
			}
		}
	}

	// Directory decisions
	for (const p of dirPaths) {
		const local = localFiles.get(p)
		const remote = remoteFiles.get(p)
		const last = lastSyncFiles.get(p)

		if (local && remote) {
			logger.debug(`Noop dir — "${p}"`)
			tasks.push(taskFactory.createNoopTask(opts(p)))
		} else if (local && !remote) {
			// C3: Check invalid chars for mkdir-remote
			if (hasInvalidChar(p)) {
				logger.debug(`Filename error dir — "${p}"`)
				tasks.push(taskFactory.createFilenameErrorTask(opts(p)))
			} else {
				logger.debug(`Mkdir remote — "${p}"`)
				tasks.push(taskFactory.createMkdirRemoteTask(opts(p)))
			}
		} else if (!local && remote) {
			logger.debug(`Mkdir local — "${p}"`)
			tasks.push(taskFactory.createMkdirLocalTask(opts(p)))
		}
		// If neither exists (in last but not in either), it naturally disappears
	}

	// I2: Sort tasks — remove (deepest first), then mkdir (shallowest first), then file tasks
	const removeTypes = new Set(['remove-local', 'remove-remote'])
	const mkdirTypes = new Set(['mkdir-local', 'mkdir-remote'])

	const removeTasks = tasks.filter((t) => removeTypes.has((t as any).type))
	const mkdirTasks = tasks.filter((t) => mkdirTypes.has((t as any).type))
	const fileTasks = tasks.filter(
		(t) =>
			!removeTypes.has((t as any).type) && !mkdirTypes.has((t as any).type),
	)

	// Remove tasks: deepest first (descending depth)
	removeTasks.sort((a, b) => countDepth(b.localPath) - countDepth(a.localPath))
	// Mkdir tasks: shallowest first (ascending depth)
	mkdirTasks.sort((a, b) => countDepth(a.localPath) - countDepth(b.localPath))

	return [...removeTasks, ...mkdirTasks, ...fileTasks]
}

function toStat(f: DBFile): {
	mtime: number
	size: number
	path: string
	basename: string
	isDir: false
	isDeleted: boolean
} {
	const parts = f.path.split('/')
	return {
		mtime: f.mtime,
		size: f.size,
		path: f.path,
		basename: parts[parts.length - 1],
		isDir: false,
		isDeleted: false,
	}
}
