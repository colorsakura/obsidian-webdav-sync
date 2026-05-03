import { isEqual, noop } from 'lodash-es'
import type { BufferLike } from 'webdav'
import { bufferLikeToArrayBuffer } from '~/utils/buffer-like'
import { decrypt, encrypt } from '~/crypto'
import i18n from '~/i18n'
import type { StatModel } from '~/model/stat.model'
import type { SyncRecordModel } from '~/model/sync-record.model'
import { blobStore } from '~/storage/blob'
import { isMergeablePath } from '~/sync/utils/is-mergeable-path'
import { isSameTime } from '~/utils/is-same-time'
import logger from '~/utils/logger'
import { mergeDigIn } from '~/utils/merge-dig-in'
import { statVaultItem } from '~/utils/stat-vault-item'
import { statWebDAVItem } from '~/utils/stat-webdav-item'
import {
	LatestTimestampResolution,
	resolveByIntelligentMerge,
	resolveByLatestTimestamp,
} from '../core/merge-utils'
import type { BaseTaskOptions } from './task.interface'
import { BaseTask, toTaskError } from './task.interface'
import { ConflictStrategy } from './conflict-strategy'

export { ConflictStrategy }

export default class ConflictResolveTask extends BaseTask {
	constructor(
		public readonly options: BaseTaskOptions & {
			record?: SyncRecordModel
			strategy: ConflictStrategy
			remoteStat?: StatModel
			localStat?: StatModel
			useGitStyle: boolean
		},
	) {
		super(options)
	}

	async exec() {
		try {
			const local =
				this.options.localStat ??
				(await statVaultItem(this.vault, this.localPath))

			if (!local) {
				throw new Error('Local file not found: ' + this.localPath)
			}

			const remote =
				this.options.remoteStat ??
				(await statWebDAVItem(this.webdav, this.remotePath))

			if (remote.isDir) {
				throw new Error('Remote path is a directory: ' + this.remotePath)
			}

			if (local.isDir) {
				throw new Error('Local path is a directory: ' + this.localPath)
			}

			if (local.size === 0 && remote.size === 0) {
				return { success: true } as const
			}

			switch (this.options.strategy) {
				case ConflictStrategy.DiffMatchPatch:
					return await this.execIntelligentMerge()
				case ConflictStrategy.LatestTimeStamp:
					return await this.execLatestTimeStamp(local, remote)
				case ConflictStrategy.Skip:
					// Skip conflict resolution - keep files as they are
					// Don't update record to preserve conflict state for next sync
					return { success: true, skipRecord: true } as const
				case ConflictStrategy.DiffMatchPatchOrSkip:
					return await this.execIntelligentMergeOrSkip()
			}
		} catch (e) {
			logger.error(this, e)
			return {
				success: false,
				error: toTaskError(e, this),
			}
		}
	}

	async execLatestTimeStamp(local: StatModel, remote: StatModel) {
		try {
			// At this point we know both local and remote are files (not directories)
			// so mtime is guaranteed to exist
			const localMtime = local.mtime!
			const remoteMtime = remote.mtime!

			if (isSameTime(remoteMtime, localMtime)) {
				return { success: true } as const
			}

			const exists = await this.vault.adapter.exists(this.localPath)
			if (!exists) {
				return {
					success: false,
					error: toTaskError(
						new Error('cannot find file in local fs: ' + this.localPath),
						this,
					),
				}
			}
			const localContent = await this.vault.adapter.readBinary(this.localPath)
			const remoteBuffer = (await this.webdav.getFileContents(this.remotePath, {
				details: false,
				format: 'binary',
			})) as BufferLike
			let remoteContent = bufferLikeToArrayBuffer(remoteBuffer)

			// 端到端解密（仅解密远端内容，本地始终为明文）
			if (this.options.encryptionKey) {
				remoteContent = await decrypt(remoteContent, this.options.encryptionKey)
			}

			const result = resolveByLatestTimestamp({
				localMtime,
				remoteMtime,
				localContent,
				remoteContent,
			})

			switch (result.status) {
				case LatestTimestampResolution.UseRemote:
					await this.vault.adapter.writeBinary(
						this.localPath,
						result.content as ArrayBuffer,
					)
					break
				case LatestTimestampResolution.UseLocal: {
					let content =
						result.content instanceof ArrayBuffer
							? result.content
							: new Uint8Array(result.content).buffer
					// 端到端加密（写回远端）
					if (this.options.encryptionKey) {
						content = await encrypt(content, this.options.encryptionKey)
					}
					await this.webdav.putFileContents(this.remotePath, content, {
						overwrite: true,
					})
					break
				}
				case LatestTimestampResolution.NoChange:
					noop()
					break
			}

			return { success: true } as const
		} catch (e) {
			logger.error(this, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}

	async execIntelligentMergeOrSkip() {
		try {
			const exists = await this.vault.adapter.exists(this.localPath)
			if (!exists) {
				throw new Error('cannot find file in local fs: ' + this.localPath)
			}
			const localBuffer = await this.vault.adapter.readBinary(this.localPath)
			const remoteBuffer = (await this.webdav.getFileContents(this.remotePath, {
				format: 'binary',
				details: false,
			})) as BufferLike
			let remoteContent = bufferLikeToArrayBuffer(remoteBuffer)

			// 端到端解密（仅解密远端内容，本地始终为明文）
			if (this.options.encryptionKey) {
				remoteContent = await decrypt(remoteContent, this.options.encryptionKey)
			}

			if (isEqual(localBuffer, remoteContent)) {
				return { success: true } as const
			}

			const { record } = this.options
			let baseBlob: Blob | null = null
			const baseKey = record?.base?.key
			if (baseKey) {
				baseBlob = await blobStore.get(baseKey)
			}

			const localIsMergeable = isMergeablePath(this.localPath)
			const remoteIsMergeable = isMergeablePath(this.remotePath)

			if (!(localIsMergeable && remoteIsMergeable)) {
				throw new Error(i18n.t('sync.error.mergeNotSupported'))
			}

			const localText = await new Blob([new Uint8Array(localBuffer)]).text()
			const remoteText = await new Blob([new Uint8Array(remoteContent)]).text()
			const baseText = (await baseBlob?.text()) ?? localText

			const mergeResult = await resolveByIntelligentMerge({
				localContentText: localText,
				remoteContentText: remoteText,
				baseContentText: baseText,
			})

			if (!mergeResult.success) {
				throw new Error(i18n.t('sync.error.failedToAutoMerge'))
			}

			if (mergeResult.isIdentical) {
				return { success: true } as const
			}

			const mergedText = mergeResult.mergedText!

			if (mergedText === remoteText) {
				if (mergedText !== localText) {
					await this.vault.adapter.write(this.localPath, mergedText)
				}
				return { success: true } as const
			}

			// 端到端加密（写回远端）
			let uploadContent: ArrayBuffer | string = mergedText
			if (this.options.encryptionKey) {
				uploadContent = await encrypt(
					textToArrayBuffer(mergedText),
					this.options.encryptionKey,
				)
			}

			const putResult = await this.webdav.putFileContents(
				this.remotePath,
				uploadContent,
				{ overwrite: true },
			)

			if (!putResult) {
				throw new Error(i18n.t('sync.error.failedToUploadMerged'))
			}

			if (localText !== mergedText) {
				await this.vault.adapter.write(this.localPath, mergedText)
			}

			return { success: true } as const
		} catch (e) {
			logger.error(this, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}

	async execIntelligentMerge() {
		try {
			const exists = await this.vault.adapter.exists(this.localPath)
			if (!exists) {
				throw new Error('cannot find file in local fs: ' + this.localPath)
			}
			const localBuffer = await this.vault.adapter.readBinary(this.localPath)
			const remoteBuffer = (await this.webdav.getFileContents(this.remotePath, {
				format: 'binary',
				details: false,
			})) as BufferLike
			let remoteContent = bufferLikeToArrayBuffer(remoteBuffer)

			// 端到端解密（仅解密远端内容，本地始终为明文）
			if (this.options.encryptionKey) {
				remoteContent = await decrypt(remoteContent, this.options.encryptionKey)
			}

			if (isEqual(localBuffer, remoteContent)) {
				return { success: true } as const
			}

			const { record } = this.options
			let baseBlob: Blob | null = null
			const baseKey = record?.base?.key
			if (baseKey) {
				baseBlob = await blobStore.get(baseKey)
			}

			const localIsMergeable = isMergeablePath(this.localPath)
			const remoteIsMergeable = isMergeablePath(this.remotePath)

			if (!(localIsMergeable && remoteIsMergeable)) {
				throw new Error(i18n.t('sync.error.mergeNotSupported'))
			}

			const localText = await new Blob([new Uint8Array(localBuffer)]).text()
			const remoteText = await new Blob([new Uint8Array(remoteContent)]).text()
			const baseText = (await baseBlob?.text()) ?? localText

			const mergeResult = await resolveByIntelligentMerge({
				localContentText: localText,
				remoteContentText: remoteText,
				baseContentText: baseText,
			})

			if (!mergeResult.success) {
				// If patch_apply fails to resolve all, use mergeDigIn as a further fallback
				const mergeDigInResult = mergeDigIn(localText, baseText, remoteText, {
					stringSeparator: '\n',
					useGitStyle: this.options.useGitStyle,
				})
				// mergeDigIn itself might produce conflict markers if it can't fully resolve.
				// The task should handle this merged text (which might contain markers).
				const mergedDmpText = mergeDigInResult.result.join('\n')

				// 端到端加密（写回远端）
				let uploadContent: ArrayBuffer | string = mergedDmpText
				if (this.options.encryptionKey) {
					uploadContent = await encrypt(
						textToArrayBuffer(mergedDmpText),
						this.options.encryptionKey,
					)
				}

				const putResult = await this.webdav.putFileContents(
					this.remotePath,
					uploadContent,
					{ overwrite: true },
				)

				if (putResult) {
					await this.vault.adapter.write(this.localPath, mergedDmpText)
					return { success: true } as const
				} else {
					throw new Error(i18n.t('sync.error.failedToUploadMerged'))
				}
			}

			if (mergeResult.isIdentical) {
				// This case should be caught by the isEqual(localBuffer, remoteBuffer) check earlier,
				// but resolveByIntelligentMerge also returns it.
				return { success: true } as const
			}

			const mergedText = mergeResult.mergedText!

			// If mergedText is the same as remoteText, we only need to update localText if it's different.
			if (mergedText === remoteText) {
				if (mergedText !== localText) {
					await this.vault.adapter.write(this.localPath, mergedText)
				}
				return { success: true } as const
			}

			// If mergedText is different from remoteText, then both remote and local need to be updated.
			// 端到端加密（写回远端）
			let uploadContent: ArrayBuffer | string = mergedText
			if (this.options.encryptionKey) {
				uploadContent = await encrypt(
					textToArrayBuffer(mergedText),
					this.options.encryptionKey,
				)
			}

			const putResult = await this.webdav.putFileContents(
				this.remotePath,
				uploadContent,
				{ overwrite: true },
			)

			if (!putResult) {
				throw new Error(i18n.t('sync.error.failedToUploadMerged'))
			}

			if (localText !== mergedText) {
				await this.vault.adapter.write(this.localPath, mergedText)
			}

			return { success: true } as const
		} catch (e) {
			logger.error(this, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}

function textToArrayBuffer(text: string): ArrayBuffer {
	const encoded = new TextEncoder().encode(text)
	return encoded.buffer.slice(
		encoded.byteOffset,
		encoded.byteOffset + encoded.byteLength,
	) as ArrayBuffer
}
