import type { SyncDB } from '../db/sync-db'
import BaseSyncDecider from './base.decider'
import type {
	ConflictTaskOptions,
	PullTaskOptions,
	SkippedTaskOptions,
	TaskFactory,
	TaskOptions,
} from './sync-decision.interface'
import { twoWayDecider } from './two-way.decider.function'
import CleanRecordTask from '../tasks/clean-record.task'
import ConflictResolveTask from '../tasks/conflict-resolve.task'
import FilenameErrorTask from '../tasks/filename-error.task'
import MkdirLocalTask from '../tasks/mkdir-local.task'
import MkdirRemoteTask from '../tasks/mkdir-remote.task'
import NoopTask from '../tasks/noop.task'
import PullTask from '../tasks/pull.task'
import PushTask from '../tasks/push.task'
import RemoveLocalTask from '../tasks/remove-local.task'
import RemoveRemoteTask from '../tasks/remove-remote.task'
import SkippedTask from '../tasks/skipped.task'
import type { BaseTask } from '../tasks/task.interface'

export default class TwoWaySyncDecider extends BaseSyncDecider {
	constructor(
		sync: BaseSyncDecider['sync'],
		private localDB: SyncDB,
		private remoteDB: SyncDB,
		private lastSyncDB: SyncDB,
		private encryptionKey?: CryptoKey | null,
	) {
		super(sync)
	}

	async decide(): Promise<BaseTask[]> {
		const taskFactory: TaskFactory = {
			createPullTask: (options: PullTaskOptions) =>
				new PullTask({
					...this.commonTaskOptions,
					...options,
					encryptionKey: this.encryptionKey,
				}),
			createPushTask: (options: TaskOptions) =>
				new PushTask({
					...this.commonTaskOptions,
					...options,
					encryptionKey: this.encryptionKey,
				}),
			createConflictResolveTask: (options: ConflictTaskOptions) =>
				new ConflictResolveTask({
					...this.commonTaskOptions,
					...options,
					encryptionKey: this.encryptionKey,
				}),
			createNoopTask: (options: TaskOptions) =>
				new NoopTask({
					...this.commonTaskOptions,
					...options,
					encryptionKey: this.encryptionKey,
				}),
			createRemoveLocalTask: (options: TaskOptions) =>
				new RemoveLocalTask({
					...this.commonTaskOptions,
					...options,
					encryptionKey: this.encryptionKey,
				}),
			createRemoveRemoteTask: (options: TaskOptions) =>
				new RemoveRemoteTask({
					...this.commonTaskOptions,
					...options,
					encryptionKey: this.encryptionKey,
				}),
			createMkdirLocalTask: (options: TaskOptions) =>
				new MkdirLocalTask({
					...this.commonTaskOptions,
					...options,
					encryptionKey: this.encryptionKey,
				}),
			createMkdirRemoteTask: (options: TaskOptions) =>
				new MkdirRemoteTask({
					...this.commonTaskOptions,
					...options,
					encryptionKey: this.encryptionKey,
				}),
			createCleanRecordTask: (options: TaskOptions) =>
				new CleanRecordTask({
					...this.commonTaskOptions,
					...options,
					encryptionKey: this.encryptionKey,
				}),
			createFilenameErrorTask: (options: TaskOptions) =>
				new FilenameErrorTask({
					...this.commonTaskOptions,
					...options,
					encryptionKey: this.encryptionKey,
				}),
			createSkippedTask: (options: SkippedTaskOptions) =>
				new SkippedTask({
					...this.commonTaskOptions,
					...options,
					encryptionKey: this.encryptionKey,
				}),
		}

		return await twoWayDecider({
			settings: {
				skipLargeFiles: this.settings.skipLargeFiles,
				conflictStrategy: this.settings.conflictStrategy,
				useGitStyle: this.settings.useGitStyle,
				syncMode: this.settings.syncMode,
				configDir: this.vault.configDir,
				encryptionEnabled: !!this.encryptionKey,
			},
			localDB: this.localDB,
			remoteDB: this.remoteDB,
			lastSyncDB: this.lastSyncDB,
			remoteBaseDir: this.remoteBaseDir,
			taskFactory,
		})
	}

	private get commonTaskOptions() {
		return {
			webdav: this.webdav,
			vault: this.vault,
			remoteBaseDir: this.remoteBaseDir,
		}
	}
}
