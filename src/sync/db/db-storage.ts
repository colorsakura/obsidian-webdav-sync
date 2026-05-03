import type { WebDAVClient } from 'webdav'
import { SyncDB } from './sync-db'
import logger from '~/utils/logger'

export class DBStorage {
	private dbPath: string

	constructor(
		private webdav: WebDAVClient,
		remoteBaseDir: string,
	) {
		this.dbPath = `${remoteBaseDir.replace(/\/$/, '')}/_sync/db`
	}

	async download(): Promise<SyncDB | undefined> {
		try {
			const data = (await this.webdav.getFileContents(
				this.dbPath,
			)) as ArrayBuffer
			if (!data || data.byteLength === 0) {
				return undefined
			}
			return await SyncDB.fromBuffer(data)
		} catch (e: any) {
			if (e.status === 404) {
				return undefined
			}
			logger.warn('DBStorage: 下载 DB 失败', e)
			throw e
		}
	}

	async upload(db: SyncDB): Promise<void> {
		const buffer = db.toBuffer()
		await this.webdav.putFileContents(this.dbPath, buffer, {
			contentLength: buffer.byteLength,
			overwrite: true,
		})
		logger.debug(`DBStorage: DB 已上传 (${buffer.byteLength} bytes)`)
	}

	static async validate(buffer: ArrayBuffer): Promise<boolean> {
		try {
			const header = new Uint8Array(buffer.slice(0, 16))
			const magic = new TextDecoder().decode(header)
			// SQLite header: "SQLite format 3\0" (16 bytes including null terminator)
			if (!magic.startsWith('SQLite format 3')) {
				return false
			}
			await SyncDB.fromBuffer(buffer)
			return true
		} catch {
			return false
		}
	}
}
