import { Mutex } from 'async-mutex'
import { getDirectoryContents } from '~/api/webdav'
import type { StatModel } from '~/model/stat.model'
import { fileStatToStatModel } from './file-stat-to-stat-model'
import { is503Error } from './is-503-error'
import logger from './logger'
import sleep from './sleep'
import { stdRemotePath } from './std-remote-path'
import type { MaybePromise } from './types'

const traversalLocks = new Map<string, Mutex>()

function getTraversalLock(key: string): Mutex {
	if (!traversalLocks.has(key)) {
		traversalLocks.set(key, new Mutex())
	}
	return traversalLocks.get(key)!
}

async function executeWithRetry<T>(func: () => MaybePromise<T>): Promise<T> {
	while (true) {
		try {
			return await func()
		} catch (err) {
			if (is503Error(err as any)) {
				await sleep(30_000)
			} else {
				throw err
			}
		}
	}
}

export class ResumableWebDAVTraversal {
	private token: string
	private remoteBaseDir: string
	private endpoint: string
	private lockKey: string

	private queue: string[] = []
	private nodes: Record<string, StatModel[]> = {}

	constructor(options: {
		token: string
		remoteBaseDir: string
		endpoint: string
	}) {
		this.token = options.token
		this.remoteBaseDir = options.remoteBaseDir
		this.endpoint = options.endpoint
		this.lockKey = `${this.token}:${stdRemotePath(this.remoteBaseDir)}`
	}

	get lock() {
		return getTraversalLock(this.lockKey)
	}

	async traverse(): Promise<StatModel[]> {
		return await this.lock.runExclusive(async () => {
			this.queue = [this.remoteBaseDir]
			this.nodes = {}

			await this.bfsTraverse()

			const results: StatModel[] = []
			for (const items of Object.values(this.nodes)) {
				results.push(...items)
			}
			return results
		})
	}

	private async bfsTraverse(): Promise<void> {
		while (this.queue.length > 0) {
			const currentPath = this.queue[0]
			const normalizedPath = stdRemotePath(currentPath)

			try {
				const contents = await executeWithRetry(() =>
					getDirectoryContents(this.token, currentPath, this.endpoint),
				)

				const resultItems = contents.map(fileStatToStatModel)

				for (const item of resultItems) {
					if (item.isDir) {
						this.queue.push(item.path)
					}
				}

				this.nodes[normalizedPath] = resultItems
				this.queue.shift()
			} catch (err) {
				logger.error(`Error processing ${currentPath}`, err)
				throw err
			}
		}
	}
}
