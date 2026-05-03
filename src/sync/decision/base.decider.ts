import type { NutstoreSync } from '..'
import type { WebDAVClient } from 'webdav'
import type { Vault } from 'obsidian'

export default class BaseSyncDecider {
	constructor(public sync: NutstoreSync) {}

	get webdav(): WebDAVClient {
		return this.sync.webdav
	}

	get vault(): Vault {
		return this.sync.vault
	}

	get remoteBaseDir(): string {
		return this.sync.remoteBaseDir
	}

	get settings() {
		return this.sync.settings
	}
}
