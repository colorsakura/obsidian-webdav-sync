import { Vault } from 'obsidian'
import { Subscription } from 'rxjs'
import { WebDAVClient } from 'webdav'
import {
	emitEndSync,
	emitPreparingSync,
	emitSyncError,
	onCancelSync,
} from '~/events'
import logger from '~/utils/logger'
import { stdRemotePath } from '~/utils/std-remote-path'
import NutstorePlugin from '..'
import { prepare } from './stages/prepare.stage'
import { decide } from './stages/decide.stage'
import { confirm } from './stages/confirm.stage'
import { execute } from './stages/execute.stage'
import { finalize } from './stages/finalize.stage'

export enum SyncStartMode {
	MANUAL_SYNC = 'manual_sync',
	AUTO_SYNC = 'auto_sync',
}

export class WebdavSync {
	isCancelled: boolean = false

	private subscriptions: Subscription[] = []

	constructor(
		public plugin: NutstorePlugin,
		private options: {
			vault: Vault
			token: string
			remoteBaseDir: string
			webdav: WebDAVClient
		},
	) {
		this.options = Object.freeze(this.options)
		this.subscriptions.push(
			onCancelSync().subscribe(() => {
				this.isCancelled = true
			}),
		)
	}

	async start({ mode }: { mode: SyncStartMode }) {
		try {
			const showNotice = mode === SyncStartMode.MANUAL_SYNC
			emitPreparingSync({ showNotice })

			const ctx = this.createContext()

			const prep = await prepare(ctx)
			if (!prep) return

			const dec = await decide(ctx, prep)

			if (dec.allTasks.length === 0) {
				await prep.lock.release()
				emitEndSync({ showNotice, failedCount: 0 })
				return
			}

			try {
				const conf = await confirm(ctx, prep, dec, { mode, showNotice })
				if (!conf) return

				const exec = await execute(ctx, conf.confirmedTasks)

				await finalize(ctx, prep, conf, exec, { mode, showNotice })
			} finally {
				await prep.lock.release()
			}
		} catch (error) {
			emitSyncError(error as Error)
			logger.error('Sync error:', error)
		} finally {
			this.subscriptions.forEach((sub) => sub.unsubscribe())
		}
	}

	private createContext() {
		const self = this
		return {
			plugin: this.plugin,
			vault: this.vault,
			webdav: this.webdav,
			remoteBaseDir: stdRemotePath(this.options.remoteBaseDir),
			settings: this.settings,
			isCancelled: () => self.isCancelled,
		}
	}

	get app() {
		return this.plugin.app
	}

	get webdav() {
		return this.options.webdav
	}

	get vault() {
		return this.options.vault
	}

	get remoteBaseDir() {
		return this.options.remoteBaseDir
	}

	get settings() {
		return this.plugin.settings
	}

	get token() {
		return this.options.token
	}

	get endpoint() {
		return this.plugin.settings.webdavEndpoint
	}
}
