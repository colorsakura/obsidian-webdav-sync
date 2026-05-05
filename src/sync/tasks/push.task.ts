import { dirname } from 'path-browserify'
import { encrypt } from '~/crypto'
import logger from '~/utils/logger'
import { BaseTask, toTaskError } from './task.interface'

export default class PushTask extends BaseTask {
	async exec() {
		try {
			const exists = await this.vault.adapter.exists(this.localPath)
			if (!exists) {
				throw new Error('cannot find file in local fs: ' + this.localPath)
			}

			let content = await this.vault.adapter.readBinary(this.localPath)

			// 端到端加密
			if (this.options.encryptionKey) {
				content = await encrypt(content, this.options.encryptionKey)
			}

			try {
				await this.webdav.putFileContents(this.remotePath, content, {
					overwrite: true,
				})
			} catch (e: any) {
				// 坚果云在父目录不存在时返回 409 AncestorsNotFound
				if (e.status === 409) {
					await this.webdav.createDirectory(dirname(this.remotePath), {
						recursive: true,
					})
					await this.webdav.putFileContents(this.remotePath, content, {
						overwrite: true,
					})
				} else {
					throw e
				}
			}

			return { success: true } as const
		} catch (e) {
			logger.error(this, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
