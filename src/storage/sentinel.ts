import type { RemoteSentinel } from '~/model/remote-sentinel.model'
import { sentinelKV } from './kv'

export async function getSentinel(namespace: string): Promise<RemoteSentinel | null> {
  return sentinelKV.get(namespace)
}

export async function setSentinel(namespace: string, sentinel: RemoteSentinel): Promise<void> {
  await sentinelKV.set(namespace, sentinel)
}

export async function clearSentinel(namespace: string): Promise<void> {
  await sentinelKV.unset(namespace)
}
