import logger from '~/utils/logger'
import { BaseTask, toTaskError } from './task.interface'

export default class PushTask extends BaseTask {
	async exec() {
		try {
			const exists = await this.vault.adapter.exists(this.localPath)
			if (!exists) {
				throw new Error('cannot find file in local fs: ' + this.localPath)
			}

			const content = await this.vault.adapter.readBinary(this.localPath)
			const res = await this.webdav.putFileContents(this.remotePath, content, {
				overwrite: true,
			})
			if (!res) {
				throw new Error('Upload failed')
			}
			return { success: res }
		} catch (e) {
			logger.error(this, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
