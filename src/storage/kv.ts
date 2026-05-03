import localforage from 'localforage'
import type { StatModel } from '~/model/stat.model'
import useStorage from './use-storage'

const DB_NAME = 'Nutstore_Plugin_Cache'

export interface TraverseWebDAVCache {
	rootCursor?: string
	queue: string[]
	nodes: Record<string, StatModel[]>
}

export const traverseWebDAVKV = useStorage<TraverseWebDAVCache>(
	localforage.createInstance({
		name: DB_NAME,
		storeName: 'traverse_webdav_cache',
	}),
)
