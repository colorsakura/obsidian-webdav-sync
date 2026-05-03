import type { SyncDB } from '../db/sync-db'
import type { StatModel } from '~/model/stat.model'
import type { SyncMode } from '~/settings'
import type { ConflictStrategy } from '../tasks/conflict-strategy'
import type { SkipReason } from '../tasks/skipped.task'
import type { BaseTask } from '../tasks/task.interface'

export interface SyncDecisionSettings {
	skipLargeFiles: { maxSize: string }
	conflictStrategy: ConflictStrategy
	useGitStyle: boolean
	syncMode: SyncMode
	configDir: string
	encryptionEnabled: boolean
}

export interface TaskOptions {
	remotePath: string
	localPath: string
	remoteBaseDir: string
}

export interface ConflictTaskOptions extends TaskOptions {
	strategy: ConflictStrategy
	localStat: StatModel
	remoteStat: StatModel
	useGitStyle: boolean
}

export interface PullTaskOptions extends TaskOptions {
	remoteSize: number
}

export type SkippedTaskOptions = TaskOptions &
	(
		| {
				reason: SkipReason.FileTooLarge
				maxSize: number
				remoteSize: number
				localSize?: number
		  }
		| {
				reason: SkipReason.FileTooLarge
				maxSize: number
				remoteSize?: number
				localSize: number
		  }
		| {
				reason: SkipReason.FileTooLarge
				maxSize: number
				remoteSize: number
				localSize: number
		  }
		| {
				reason: SkipReason.FolderContainsIgnoredItems
				ignoredPaths: string[]
		  }
	)

export interface TaskFactory {
	createPullTask(options: PullTaskOptions): BaseTask
	createPushTask(options: TaskOptions): BaseTask
	createConflictResolveTask(options: ConflictTaskOptions): BaseTask
	createNoopTask(options: TaskOptions): BaseTask
	createRemoveLocalTask(options: TaskOptions): BaseTask
	createRemoveRemoteTask(options: TaskOptions): BaseTask
	createMkdirLocalTask(options: TaskOptions): BaseTask
	createMkdirRemoteTask(options: TaskOptions): BaseTask
	createCleanRecordTask(options: TaskOptions): BaseTask
	createFilenameErrorTask(options: TaskOptions): BaseTask
	createSkippedTask(options: SkippedTaskOptions): BaseTask
}

export interface SyncDecisionInput {
	settings: SyncDecisionSettings
	localDB: SyncDB
	remoteDB: SyncDB
	lastSyncDB: SyncDB
	remoteBaseDir: string
	taskFactory: TaskFactory
}
