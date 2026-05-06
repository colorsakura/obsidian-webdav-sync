import type { SyncStartMode } from '~/sync'
import { WebdavSync } from '~/sync'
import waitUntil from '~/utils/wait-until'
import type NutstorePlugin from '..'

export interface SyncOptions {
	mode: SyncStartMode
}

export default class SyncExecutorService {
	constructor(private plugin: NutstorePlugin) {}

	async executeSync(options: SyncOptions) {
		if (this.plugin.isSyncing) {
			return false
		}

		// 检查账号配置，未配置时静默返回（自动同步场景）
		if (!this.plugin.isAccountConfigured()) {
			return false
		}

		await waitUntil(() => !this.plugin.isSyncing, 500)

		const sync = new WebdavSync(this.plugin, {
			vault: this.plugin.app.vault,
			token: await this.plugin.getToken(),
			remoteBaseDir: this.plugin.remoteBaseDir,
			webdav: await this.plugin.webDAVService.createWebDAVClient(),
		})

		await sync.start({
			mode: options.mode,
		})

		return true
	}
}
