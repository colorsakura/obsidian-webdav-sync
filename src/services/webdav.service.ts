import { createClient, WebDAVClient } from 'webdav'
import WebdavSyncPlugin from '../index'
import { createRateLimitedWebDAVClient } from '../utils/rate-limited-client'

export class WebDAVService {
	constructor(private plugin: WebdavSyncPlugin) {}

	async createWebDAVClient(): Promise<WebDAVClient> {
		const client = createClient(this.plugin.settings.webdavEndpoint, {
			username: this.plugin.settings.webdavUsername,
			password: this.plugin.settings.webdavPassword,
		})
		return createRateLimitedWebDAVClient(client)
	}

	async checkWebDAVConnection(): Promise<{ error?: Error; success: boolean }> {
		try {
			const client = await this.createWebDAVClient()
			return { success: await client.exists('/') }
		} catch (error) {
			return {
				error: error as Error,
				success: false,
			}
		}
	}
}
