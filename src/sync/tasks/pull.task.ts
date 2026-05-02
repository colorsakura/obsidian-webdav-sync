import { dirname } from 'path-browserify'
import type { BufferLike } from 'webdav'
import { bufferLikeToArrayBuffer } from '~/utils/buffer-like'
import { decrypt, ENCRYPTION_OVERHEAD } from '~/crypto'
import logger from '~/utils/logger'
import { mkdirsVault } from '~/utils/mkdirs-vault'
import type { BaseTaskOptions } from './task.interface'
import { BaseTask, toTaskError } from './task.interface'

export default class PullTask extends BaseTask {
	constructor(
		readonly options: BaseTaskOptions & {
			remoteSize: number
		},
	) {
		super(options)
	}

	get remoteSize() {
		return this.options.remoteSize
	}

	async exec() {
		try {
			const file = (await this.webdav.getFileContents(this.remotePath, {
				format: 'binary',
				details: false,
			})) as BufferLike
			let arrayBuffer = bufferLikeToArrayBuffer(file)

			// 端到端解密
			if (this.options.encryptionKey) {
				arrayBuffer = await decrypt(arrayBuffer, this.options.encryptionKey)
			}

			const expectedSize = this.options.encryptionKey
				? this.remoteSize - ENCRYPTION_OVERHEAD
				: this.remoteSize
			if (arrayBuffer.byteLength !== expectedSize) {
				throw new Error('Remote Size Not Match!')
			}
			await mkdirsVault(this.vault, dirname(this.localPath))
			await this.vault.adapter.writeBinary(this.localPath, arrayBuffer)
			return { success: true } as const
		} catch (e) {
			logger.error(this, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
