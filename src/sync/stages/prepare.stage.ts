import { Notice, Platform, Vault } from 'obsidian'
import type { WebDAVClient } from 'webdav'
import {
  loadEncryptionKey,
  sampleRemoteEncryption,
  SECRET_ID,
  showRestoreKeyModal,
} from '~/crypto'
import { emitSyncError } from '~/events'
import i18n from '~/i18n'
import { is503Error } from '~/utils/is-503-error'
import logger from '~/utils/logger'
import { computeEffectiveFilterRules } from '~/utils/config-dir-rules'
import type NutstorePlugin from '~/index'
import type { NutstoreSettings } from '~/settings'
import { SyncDB } from '../db/sync-db'
import { SyncLock } from '../db/sync-lock'
import { DBStorage } from '../db/db-storage'
import { loadLastSyncDB } from '../utils/sync-db-persistence'
import { handle503Error } from './shared'

export interface SyncContext {
  plugin: NutstorePlugin
  vault: Vault
  webdav: WebDAVClient
  remoteBaseDir: string
  settings: NutstoreSettings
  isCancelled: () => boolean
}

export interface PrepareOutput {
  encryptionKey: CryptoKey | null
  lastSyncDB: SyncDB
  remoteDB: SyncDB
  localDB: SyncDB
  deviceId: string
  sessionId: string
  startedAt: number
  lock: SyncLock
  dbStorage: DBStorage
}

function platformLabel(): string {
  if (Platform.isIosApp) return 'ios'
  if (Platform.isAndroidApp) return 'android'
  if (Platform.isDesktopApp) return 'desktop'
  return 'unknown'
}

export async function prepare(
  ctx: SyncContext,
): Promise<PrepareOutput | null> {
  const webdav = ctx.webdav

  // --- 加密密钥加载 ---
  let encryptionKey = await loadEncryptionKey(
    ctx.plugin.app,
    ctx.settings.encryption,
  )

  if (!encryptionKey) {
    const lastDB = await loadLastSyncDB(ctx.vault.getName(), ctx.remoteBaseDir)
    if (!lastDB || lastDB.getAllFiles().length === 0) {
      let remoteEncrypted = false
      try {
        remoteEncrypted = await sampleRemoteEncryption(webdav, ctx.remoteBaseDir)
      } catch {
        // 采样失败不阻塞同步
      }
      if (remoteEncrypted) {
        const password = await showRestoreKeyModal(
          ctx.plugin.app,
          ctx.settings.encryption,
          '检测到远程数据已加密',
          '远程文件已使用端到端加密。请输入密码恢复密钥以继续同步。',
        )
        if (!password) {
          emitSyncError(new Error(i18n.t('sync.cancelled')))
          return null
        }
        ctx.settings.encryption.enabled = true
        ctx.settings.encryption.secretId = SECRET_ID
        await ctx.plugin.saveSettings()
        encryptionKey = await loadEncryptionKey(
          ctx.plugin.app,
          ctx.settings.encryption,
        )
      }
    } else if (ctx.settings.encryption.enabled) {
      new Notice('加密密钥未找到，请在设置 → 加密中恢复密钥', 8000)
    }
  }

  // --- 远程目录确保 ---
  let remoteBaseDirExits = await webdav.exists(ctx.remoteBaseDir)

  if (!remoteBaseDirExits) {
    try {
      const key =
        'last_sync_db::' + ctx.vault.getName() + '::' + ctx.remoteBaseDir
      await (await import('localforage')).removeItem(key)
    } catch {
      // Ignore cleanup errors
    }
  }

  while (!remoteBaseDirExits) {
    if (ctx.isCancelled()) {
      emitSyncError(new Error(i18n.t('sync.cancelled')))
      return null
    }
    try {
      await webdav.createDirectory(ctx.remoteBaseDir, { recursive: true })
      break
    } catch (e) {
      if (is503Error(e as any)) {
        await handle503Error(60000, ctx.isCancelled)
        if (ctx.isCancelled()) {
          emitSyncError(new Error(i18n.t('sync.cancelled')))
          return null
        }
        remoteBaseDirExits = await webdav.exists(ctx.remoteBaseDir)
      } else {
        throw e
      }
    }
  }

  // --- DB 加载与设备信息 ---
  let lastSyncDB = await loadLastSyncDB(ctx.vault.getName(), ctx.remoteBaseDir)
  let deviceId: string
  if (lastSyncDB) {
    deviceId = lastSyncDB.deviceId || crypto.randomUUID()
  } else {
    deviceId = crypto.randomUUID()
    lastSyncDB = await SyncDB.empty(deviceId)
  }

  const sessionId = crypto.randomUUID()
  const startedAt = Date.now()

  // --- 锁获取 ---
  const lock = new SyncLock(webdav, ctx.remoteBaseDir, deviceId)
  const locked = await lock.acquire()
  if (!locked) {
    emitSyncError(new Error('无法获取同步锁，请稍后重试'))
    return null
  }

  // --- Remote DB 下载 ---
  const filterRules = computeEffectiveFilterRules(ctx.plugin)
  const dbStorage = new DBStorage(webdav, ctx.remoteBaseDir)
  const downloadedDB = await dbStorage.download()
  let remoteDB: SyncDB
  if (downloadedDB && downloadedDB.getAllFiles().length > 0) {
    remoteDB = downloadedDB
  } else if (lastSyncDB && lastSyncDB.getAllFiles().length > 0) {
    logger.warn('远程 DB 不可用，使用 lastSyncDB 回退')
    remoteDB = lastSyncDB
  } else {
    remoteDB = await SyncDB.empty('remote')
  }

  // --- 设备信息写入 ---
  remoteDB.upsertDevice({
    deviceId,
    deviceName: '',
    platform: platformLabel(),
    lastOnlineAt: Date.now(),
    firstSeenAt: Date.now(),
  })

  // --- 增量本地扫描 ---
  const localDB = await SyncDB.fromVault(
    ctx.vault,
    {
      exclude: filterRules.exclusionRules,
      include: filterRules.inclusionRules,
    },
    lastSyncDB,
  )

  return {
    encryptionKey,
    lastSyncDB,
    remoteDB,
    localDB,
    deviceId,
    sessionId,
    startedAt,
    lock,
    dbStorage,
  }
}
