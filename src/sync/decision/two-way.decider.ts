import { isEqual } from 'ohash'
import { blobStore } from '~/storage/blob'
import { SyncRecord } from '~/storage/sync-record'
import { sha256Hex } from '~/utils/sha256'
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
import { BaseTask } from '../tasks/task.interface'
import BaseSyncDecider from './base.decider'
import {
	ConflictTaskOptions,
	PullTaskOptions,
	SkippedTaskOptions,
	TaskFactory,
	TaskOptions,
} from './sync-decision.interface'
import { twoWayDecider } from './two-way.decider.function'
import { getDBKey } from '~/utils/get-db-key'
import { getSentinel } from '~/storage/sentinel'
import {
	buildRemoteStatsFromRecords,
	computeRemoteFingerprint,
} from '~/utils/remote-fingerprint'
import completeLossDir from '~/fs/utils/complete-loss-dir'

export default class TwoWaySyncDecider extends BaseSyncDecider {
	constructor(
		sync: BaseSyncDecider['sync'],
		syncRecordStorage: SyncRecord,
		private encryptionKey?: CryptoKey | null,
	) {
		super(sync, syncRecordStorage)
	}

	async decide(): Promise<BaseTask[]> {
		const syncRecordStorage = this.getSyncRecordStorage()

		// 并行获取 records + localStats（不包含 remote walk）
		const [records, localStats] = await Promise.all([
			syncRecordStorage.getRecords(),
			this.sync.localFS.walk(),
		])

		// 哨兵检测：1 次 PROPFIND 判断远端顶层是否变化
		const namespace = getDBKey(this.vault.getName(), this.remoteBaseDir)
		const cachedSentinel = await getSentinel(namespace)
		const currentFingerprint = await computeRemoteFingerprint(
			this.sync.token,
			this.sync.endpoint,
			this.remoteBaseDir,
		)

		let remoteStats

		if (cachedSentinel && cachedSentinel.fingerprint === currentFingerprint) {
			// 哨兵匹配 → 从 sync record 推断远端状态，跳过全量遍历
			const statModels = buildRemoteStatsFromRecords(records)
			const completedStats = completeLossDir(statModels, statModels)
			remoteStats = completedStats.map((stat) => ({ stat, ignored: false }))
		} else {
			// 哨兵不匹配（首次同步 / 远端有变化）→ 全量遍历
			remoteStats = await this.sync.remoteFs.walk()
		}

		// 创建共用的task选项
		const commonTaskOptions = {
			webdav: this.webdav,
			vault: this.vault,
			remoteBaseDir: this.remoteBaseDir,
			syncRecord: syncRecordStorage,
			encryptionKey: this.encryptionKey,
		}

		// 创建Task工厂
		const taskFactory: TaskFactory = {
			createPullTask: (options: PullTaskOptions) =>
				new PullTask({ ...commonTaskOptions, ...options }),
			createPushTask: (options: TaskOptions) =>
				new PushTask({ ...commonTaskOptions, ...options }),
			createConflictResolveTask: (options: ConflictTaskOptions) =>
				new ConflictResolveTask({ ...commonTaskOptions, ...options }),
			createNoopTask: (options: TaskOptions) =>
				new NoopTask({ ...commonTaskOptions, ...options }),
			createRemoveLocalTask: (options: TaskOptions) =>
				new RemoveLocalTask({ ...commonTaskOptions, ...options }),
			createRemoveRemoteTask: (options: TaskOptions) =>
				new RemoveRemoteTask({ ...commonTaskOptions, ...options }),
			createMkdirLocalTask: (options: TaskOptions) =>
				new MkdirLocalTask({ ...commonTaskOptions, ...options }),
			createMkdirRemoteTask: (options: TaskOptions) =>
				new MkdirRemoteTask({ ...commonTaskOptions, ...options }),
			createCleanRecordTask: (options: TaskOptions) =>
				new CleanRecordTask({ ...commonTaskOptions, ...options }),
			createFilenameErrorTask: (options: TaskOptions) =>
				new FilenameErrorTask({ ...commonTaskOptions, ...options }),
			createSkippedTask: (options: SkippedTaskOptions) =>
				new SkippedTask({ ...commonTaskOptions, ...options }),
		}

		// 文件内容比较函数
		const compareFileContent = async (
			filePath: string,
			baseContent: ArrayBuffer,
		): Promise<boolean> => {
			const exists = await this.vault.adapter.exists(filePath)
			if (!exists) return false
			const currentContent = await this.vault.adapter.readBinary(filePath)
			return isEqual(baseContent, currentContent)
		}
		const compareFileHash = async (
			filePath: string,
			expectedHash: string,
		): Promise<boolean> => {
			const exists = await this.vault.adapter.exists(filePath)
			if (!exists) return false
			const currentContent = await this.vault.adapter.readBinary(filePath)
			const currentHash = await sha256Hex(currentContent)
			return currentHash === expectedHash
		}
		const getBaseContent = async (key: string): Promise<ArrayBuffer | null> => {
			const blob = await blobStore.get(key)
			if (!blob) {
				return null
			}
			return await blob.arrayBuffer()
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
			localStats,
			remoteStats,
			syncRecords: records,
			remoteBaseDir: this.remoteBaseDir,
			getBaseContent,
			compareFileContent,
			compareFileHash,
			taskFactory,
		})
	}
}
