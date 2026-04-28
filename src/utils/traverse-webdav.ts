import { Mutex } from 'async-mutex'
import { getDirectoryContents } from '~/api/webdav'
import { StatModel } from '~/model/stat.model'
import { traverseWebDAVKV } from '~/storage'
import { fileStatToStatModel } from './file-stat-to-stat-model'
import { is503Error } from './is-503-error'
import logger from './logger'
import sleep from './sleep'
import { stdRemotePath } from './std-remote-path'
import { MaybePromise } from './types'

// Global mutex map: one lock per kvKey
const traversalLocks = new Map<string, Mutex>()

function getTraversalLock(kvKey: string): Mutex {
	if (!traversalLocks.has(kvKey)) {
		traversalLocks.set(kvKey, new Mutex())
	}
	return traversalLocks.get(kvKey)!
}

async function executeWithRetry<T>(func: () => MaybePromise<T>): Promise<T> {
	while (true) {
		try {
			return await func()
		} catch (err) {
			if (is503Error(err)) {
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
	private kvKey: string
	private endpoint: string
	private saveInterval: number

	private queue: string[] = []
	private nodes: Record<string, StatModel[]> = {}
	private processedCount: number = 0

	/**
	 * Normalize directory path for use as nodes key
	 */
	private normalizeDirPath(path: string): string {
		return stdRemotePath(path)
	}

	constructor(options: {
		token: string
		remoteBaseDir: string
		kvKey: string
		endpoint: string
		saveInterval?: number
	}) {
		this.token = options.token
		this.remoteBaseDir = options.remoteBaseDir
		this.kvKey = options.kvKey
		this.endpoint = options.endpoint
		this.saveInterval = Math.max(options.saveInterval || 1, 1)
	}

	get lock() {
		return getTraversalLock(this.kvKey)
	}

	async traverse(): Promise<StatModel[]> {
		return await this.lock.runExclusive(async () => {
			await this.loadState()

			if (this.queue.length === 0) {
				this.queue = [this.remoteBaseDir]
			}

			await this.bfsTraverse()
			await this.saveState()

			return this.getAllFromCache()
		})
	}

	/**
	 * BFS traversal
	 */
	private async bfsTraverse(): Promise<void> {
		while (this.queue.length > 0) {
			const currentPath = this.queue[0]
			const normalizedPath = this.normalizeDirPath(currentPath)

			try {
				let resultItems: StatModel[]

				const cachedItems = this.nodes[normalizedPath]
				if (cachedItems) {
					resultItems = cachedItems
				} else {
					const contents = await executeWithRetry(() =>
						getDirectoryContents(this.token, currentPath, this.endpoint),
					)

					resultItems = contents.map(fileStatToStatModel)
				}

				for (const item of resultItems) {
					if (item.isDir) {
						this.queue.push(item.path)
					}
				}

				this.nodes[normalizedPath] = resultItems
				this.queue.shift()
				this.processedCount++

				if (this.processedCount % this.saveInterval === 0) {
					await this.saveState()
				}
			} catch (err) {
				logger.error(`Error processing ${currentPath}`, err)
				await this.saveState()
				throw err
			}
		}
	}

	/**
	 * Get all results from cache
	 */
	private getAllFromCache(): StatModel[] {
		const results: StatModel[] = []
		for (const items of Object.values(this.nodes)) {
			results.push(...items)
		}
		return results
	}

	/**
	 * Load state
	 */
	private async loadState(): Promise<void> {
		const cache = await traverseWebDAVKV.get(this.kvKey)
		if (cache) {
			this.queue = cache.queue || []
			this.nodes = cache.nodes || {}
		}
	}

	/**
	 * Save current state
	 */
	private async saveState(): Promise<void> {
		await traverseWebDAVKV.set(this.kvKey, {
			queue: this.queue,
			nodes: this.nodes,
		})
	}

	/**
	 * Clear cache (force re-traversal)
	 */
	async clearCache(): Promise<void> {
		await traverseWebDAVKV.unset(this.kvKey)
		this.queue = []
		this.nodes = {}
		this.processedCount = 0
	}

	/**
	 * Check if cache is valid
	 */
	async isCacheValid(): Promise<boolean> {
		const cache = await traverseWebDAVKV.get(this.kvKey)
		if (!cache) {
			return false
		}

		// Cache is valid if queue is empty (traversal completed)
		return cache.queue.length === 0
	}
}
