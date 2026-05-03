import localforage from 'localforage'
import { SyncDB } from '../db/sync-db'
import logger from '~/utils/logger'

const LAST_SYNC_DB_PREFIX = 'last_sync_db::'

function makeKey(vaultName: string, remoteBaseDir: string): string {
  return LAST_SYNC_DB_PREFIX + vaultName + '::' + remoteBaseDir
}

export async function loadLastSyncDB(
  vaultName: string,
  remoteBaseDir: string,
): Promise<SyncDB | undefined> {
  try {
    const key = makeKey(vaultName, remoteBaseDir)
    const buffer = await localforage.getItem<ArrayBuffer>(key)
    if (!buffer) return undefined
    return await SyncDB.fromBuffer(buffer)
  } catch (e) {
    logger.warn('Failed to load lastSyncDB:', e)
    return undefined
  }
}

export async function saveLastSyncDB(
  vaultName: string,
  remoteBaseDir: string,
  db: SyncDB,
): Promise<void> {
  const key = makeKey(vaultName, remoteBaseDir)
  await localforage.setItem(key, db.toBuffer())
  logger.debug(`lastSyncDB saved (${db.getAllFiles().length} files)`)
}

export async function getDeviceId(vaultName: string, remoteBaseDir: string): Promise<string> {
  const lastDB = await loadLastSyncDB(vaultName, remoteBaseDir)
  if (lastDB) return lastDB.deviceId
  // Generate and persist a new device ID
  const deviceId = crypto.randomUUID()
  return deviceId
}
