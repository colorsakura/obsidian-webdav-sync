# Sync Pipeline 重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `NutstoreSync.start()` 方法 (~500行) 拆分为 5 个独立 stage 文件，sync/index.ts 缩减为纯编排层。

**Architecture:** 每个 stage 是独立异步函数，接收 `SyncContext` + 阶段特定输入，返回阶段输出或 `null`。阶段间通过类型化的输出对象传递数据。

**Tech Stack:** TypeScript, Obsidian API, WebDAV client

**不变项:** 不修改 task 类、TwoWaySyncDecider/BaseSyncDecider、crypto/events/services/settings。只移动代码，不改变逻辑。测试预期不变。

---

## File Structure

```
src/sync/stages/
├── shared.ts            # handle503Error (prepare + execute 共用)
├── prepare.stage.ts     # 加密 → 远程目录 → DB → 锁 → 扫描
├── decide.stage.ts      # TwoWaySyncDecider → 任务分类
├── confirm.stage.ts     # 确认 Modal → 重上传逻辑
├── execute.stage.ts     # 分批执行 → 503 重试 → 进度
└── finalize.stage.ts    # buildNewDB → session → upload → save → 事件
```

## Shared Type: SyncContext

定义在 prepare.stage.ts 中（首先被使用），其它 stage 从 prepare 导入。或用独立 `context.ts` 文件。

实际：定义在 `prepare.stage.ts` 中并 export，其它 stage 从该文件导入。

```typescript
// src/sync/stages/prepare.stage.ts (部分)

import type { Vault } from 'obsidian'
import type { WebDAVClient } from 'webdav'
import type NutstorePlugin from '~/index'
import type { NutstoreSettings } from '~/settings'

export interface SyncContext {
  plugin: NutstorePlugin
  vault: Vault
  webdav: WebDAVClient
  remoteBaseDir: string
  settings: NutstoreSettings
  isCancelled: () => boolean
}
```

---

### Task 1: Create shared.ts (handle503Error)

**Why first:** prepare 和 execute 都依赖 `handle503Error`，先创建避免编译错误。

**Files:**
- Create: `src/sync/stages/shared.ts`

- [ ] **Step 1: Write shared.ts**

```typescript
import { Notice, moment } from 'obsidian'
import { onCancelSync } from '~/events'
import i18n from '~/i18n'
import breakableSleep from '~/utils/breakable-sleep'

/**
 * 等待 60 秒后重试，显示 Notice 提示下次重试时间。
 * 从 NutstoreSync.handle503Error 提取，参数化 isCancelled。
 */
export async function handle503Error(waitMs: number, isCancelled: () => boolean) {
  const now = Date.now()
  const startAt = now + waitMs
  new Notice(
    i18n.t('sync.requestsTooFrequent', {
      time: (moment as any)(startAt).format('HH:mm:ss'),
    }),
  )
  await breakableSleep(onCancelSync(), startAt - now)
}
```

- [ ] **Step 2: Type check**

Run: `bun run build 2>&1 | head -5` (预期: 这个文件本身没有错误)

- [ ] **Step 3: Commit**

```bash
git add src/sync/stages/shared.ts
git commit -m "refactor: extract handle503Error to shared stage utility"
```

---

### Task 2: Create prepare.stage.ts

**Files:**
- Create: `src/sync/stages/prepare.stage.ts`

从 `src/sync/index.ts` 提取：
- Lines 83-128: 加密密钥加载 + 新设备检测
- Lines 130-165: 远程目录确保 (含 503 重试)
- Lines 167-175: lastSyncDB 加载 + deviceId/sessionId
- Lines 180-186: 锁获取
- Lines 188-220: remoteDB 下载 + 设备信息写入 + 本地增量扫描

**Adaptation rules (mechanical):**
- `this.vault` → `ctx.vault`
- `this.webdav` → `ctx.webdav`
- `this.app` → `ctx.plugin.app`
- `this.settings` → `ctx.settings`
- `this.plugin` → `ctx.plugin`
- `this.isCancelled` → `ctx.isCancelled()`
- `this.options.remoteBaseDir` (即 line 80 的 local var) → `ctx.remoteBaseDir`
- `this.platformLabel` → 内联 Platform 判断
- `return` (取消退出时) → `return null`

- [ ] **Step 1: Write prepare.stage.ts**

```typescript
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
import { stdRemotePath } from '~/utils/std-remote-path'
import { computeEffectiveFilterRules } from '~/utils/config-dir-rules'
import NutstorePlugin from '~/index'
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
```

- [ ] **Step 2: Type check**

Run: `bun run build 2>&1 | head -20`
Expected: 编译通过或仅有未引用变量的 warning（因为 sync/index.ts 尚未修改，prepare.stage.ts 暂时未被任何文件 import）

- [ ] **Step 3: Commit**

```bash
git add src/sync/stages/prepare.stage.ts
git commit -m "refactor: extract prepare stage from NutstoreSync.start()"
```

---

### Task 3: Create decide.stage.ts

**Files:**
- Create: `src/sync/stages/decide.stage.ts`

从 `src/sync/index.ts` lines 222-235 提取：TwoWaySyncDecider 创建与任务分类。

**Adaptation:** `TwoWaySyncDecider` 构造函数的第一个参数需要 `NutstoreSync` 类型（因为 `BaseSyncDecider` 使用 `sync.webdav/vault/remoteBaseDir/settings`）。创建一个兼容的 plain object 并做类型断言。

- [ ] **Step 1: Write decide.stage.ts**

```typescript
import TwoWaySyncDecider from '../decision/two-way.decider'
import NoopTask from '../tasks/noop.task'
import SkippedTask from '../tasks/skipped.task'
import { BaseTask } from '../tasks/task.interface'
import type { SyncContext, PrepareOutput } from './prepare.stage'

export interface DecideOutput {
  allTasks: BaseTask[]
  substantialTasks: BaseTask[]
  noopTasks: BaseTask[]
  skippedTasks: BaseTask[]
}

export async function decide(
  ctx: SyncContext,
  prep: PrepareOutput,
): Promise<DecideOutput> {
  const syncLike = {
    webdav: ctx.webdav,
    vault: ctx.vault,
    remoteBaseDir: ctx.remoteBaseDir,
    settings: ctx.settings,
  } as any

  const decider = new TwoWaySyncDecider(
    syncLike,
    prep.localDB,
    prep.remoteDB,
    prep.lastSyncDB,
    prep.encryptionKey,
  )

  const allTasks = await decider.decide()

  const noopTasks = allTasks.filter((t) => t instanceof NoopTask)
  const skippedTasks = allTasks.filter((t) => t instanceof SkippedTask)
  const substantialTasks = allTasks.filter(
    (t) => !(t instanceof NoopTask || t instanceof SkippedTask),
  )

  return { allTasks, substantialTasks, noopTasks, skippedTasks }
}
```

- [ ] **Step 2: Type check**

Run: `bun run build 2>&1 | head -5`

- [ ] **Step 3: Commit**

```bash
git add src/sync/stages/decide.stage.ts
git commit -m "refactor: extract decide stage from NutstoreSync.start()"
```

---

### Task 4: Create confirm.stage.ts

**Files:**
- Create: `src/sync/stages/confirm.stage.ts`

从 `src/sync/index.ts` 提取：
- Lines 237-267: confirmBeforeSync Modal（TaskListConfirmModal）
- Lines 269-463: auto-sync 删除确认（DeleteConfirmModal）+ 重上传逻辑

**Adaptation rules (same as prepare):**
- `this.vault` → `ctx.vault`, `this.webdav` → `ctx.webdav`
- `this.app` → `ctx.plugin.app`
- `this.isCancelled` → `ctx.isCancelled()`
- `this.remoteBaseDir` → `ctx.remoteBaseDir`
- `this.plugin.progressService` → `ctx.plugin.progressService`
- `settings` (local var, line 78) → `ctx.settings`
- `mode` → `opts.mode`, `showNotice` → `opts.showNotice`

- [ ] **Step 1: Write confirm.stage.ts**

```typescript
import { Notice, Platform, normalizePath } from 'obsidian'
import { dirname } from 'path-browserify'
import DeleteConfirmModal from '~/components/DeleteConfirmModal'
import TaskListConfirmModal from '~/components/TaskListConfirmModal'
import { emitSyncError, emitStartSync } from '~/events'
import i18n from '~/i18n'
import { statVaultItem } from '~/utils/stat-vault-item'
import { stdRemotePath } from '~/utils/std-remote-path'
import CleanRecordTask from '../tasks/clean-record.task'
import MkdirRemoteTask from '../tasks/mkdir-remote.task'
import NoopTask from '../tasks/noop.task'
import PushTask from '../tasks/push.task'
import RemoveLocalTask from '../tasks/remove-local.task'
import SkippedTask from '../tasks/skipped.task'
import { BaseTask } from '../tasks/task.interface'
import { SyncStartMode } from '../index'
import type { SyncContext, PrepareOutput } from './prepare.stage'
import type { DecideOutput } from './decide.stage'

export interface ConfirmInput {
  mode: SyncStartMode
  showNotice: boolean
}

export interface ConfirmOutput {
  confirmedTasks: BaseTask[]
}

export async function confirm(
  ctx: SyncContext,
  prep: PrepareOutput,
  dec: DecideOutput,
  opts: ConfirmInput,
): Promise<ConfirmOutput | null> {
  let confirmedTasks = dec.substantialTasks
  const { mode, showNotice } = opts

  // --- confirmBeforeSync Modal ---
  const firstTaskIdxNeedingConfirmation = confirmedTasks.findIndex(
    (t) => !(t instanceof CleanRecordTask),
  )

  if (ctx.isCancelled()) {
    emitSyncError(new Error(i18n.t('sync.cancelled')))
    return null
  }

  if (showNotice && ctx.settings.confirmBeforeSync && firstTaskIdxNeedingConfirmation > -1) {
    const confirmExec = await new TaskListConfirmModal(
      ctx.plugin.app,
      confirmedTasks,
    ).open()
    if (confirmExec.confirm) {
      confirmedTasks = confirmExec.tasks
    } else {
      emitSyncError(new Error(i18n.t('sync.cancelled')))
      return null
    }
  }

  // --- auto-sync 删除确认 + 重上传逻辑 ---
  if (
    mode === SyncStartMode.AUTO_SYNC &&
    ctx.settings.confirmBeforeDeleteInAutoSync
  ) {
    const removeLocalTasks = confirmedTasks.filter(
      (t) => t instanceof RemoveLocalTask,
    ) as RemoveLocalTask[]
    if (removeLocalTasks.length > 0) {
      new Notice(i18n.t('deleteConfirm.warningNotice'), 3000)
      const { tasksToDelete, tasksToReupload } =
        await new DeleteConfirmModal(ctx.plugin.app, removeLocalTasks).open()

      const mkdirTasksMap = new Map<string, MkdirRemoteTask>()
      const pushTasks: PushTask[] = []
      const remoteExistsCache = new Set<string>()

      const markPathAndParentsAsExisting = (remotePath: string) => {
        let current = remotePath
        while (current && current !== '.' && current !== '' && current !== '/') {
          if (remoteExistsCache.has(current)) break
          remoteExistsCache.add(current)
          current = stdRemotePath(dirname(current))
        }
      }

      const ensureParentDir = async (localPath: string, remotePath: string) => {
        const parentLocalPath = normalizePath(dirname(localPath))
        const parentRemotePath = stdRemotePath(dirname(remotePath))

        if (
          parentLocalPath === '.' ||
          parentLocalPath === '' ||
          parentLocalPath === '/'
        ) return

        if (mkdirTasksMap.has(parentRemotePath)) return

        const existsInOriginal = dec.allTasks.some(
          (t) =>
            t instanceof MkdirRemoteTask &&
            t.remotePath === parentRemotePath,
        )
        if (existsInOriginal) return

        const existsInConfirmed = confirmedTasks.some(
          (t) =>
            t instanceof MkdirRemoteTask &&
            t.remotePath === parentRemotePath,
        )
        if (existsInConfirmed) return

        if (remoteExistsCache.has(parentRemotePath)) return

        try {
          await ctx.webdav.stat(parentRemotePath)
          markPathAndParentsAsExisting(parentRemotePath)
        } catch (e) {
          const mkdirTask = new MkdirRemoteTask({
            vault: ctx.vault,
            webdav: ctx.webdav,
            remoteBaseDir: ctx.remoteBaseDir,
            remotePath: parentRemotePath,
            localPath: parentLocalPath,
            encryptionKey: prep.encryptionKey,
          })
          mkdirTasksMap.set(parentRemotePath, mkdirTask)
        }
      }

      for (const task of tasksToReupload) {
        const stat = await statVaultItem(ctx.vault, task.localPath)
        if (!stat) continue

        await ensureParentDir(task.localPath, task.remotePath)

        if (stat.isDir) {
          const mkdirTask = new MkdirRemoteTask(task.options)
          mkdirTasksMap.set(task.remotePath, mkdirTask)
        } else {
          const pushTask = new PushTask(task.options)
          pushTasks.push(pushTask)
        }
      }

      const mkdirTasks = Array.from(mkdirTasksMap.values())
      const deleteTaskSet = new Set(tasksToDelete)

      for (const reuploadTask of tasksToReupload) {
        let currentPath = normalizePath(reuploadTask.localPath)
        while (currentPath && currentPath !== '.' && currentPath !== '' && currentPath !== '/') {
          currentPath = normalizePath(dirname(currentPath))
          if (currentPath === '.' || currentPath === '' || currentPath === '/') break
          for (const deleteTask of deleteTaskSet) {
            if (deleteTask.localPath === currentPath) {
              deleteTaskSet.delete(deleteTask)
              break
            }
          }
        }
      }

      const otherTasks: BaseTask[] = []
      const deleteTasks: RemoveLocalTask[] = []

      for (const t of confirmedTasks) {
        if (!(t instanceof RemoveLocalTask)) {
          otherTasks.push(t)
        } else if (deleteTaskSet.has(t)) {
          deleteTasks.push(t)
        }
      }

      confirmedTasks = [...mkdirTasks, ...otherTasks, ...pushTasks, ...deleteTasks]
    }
  }

  // --- 大量任务提示 ---
  if (confirmedTasks.length > 500 && Platform.isDesktopApp) {
    new Notice(i18n.t('sync.suggestUseClientForManyTasks'), 5000)
  }

  // --- 进度 Modal ---
  const hasSubstantialTask = confirmedTasks.some(
    (task) =>
      !(
        task instanceof NoopTask ||
        task instanceof CleanRecordTask ||
        task instanceof SkippedTask
      ),
  )
  if (showNotice && hasSubstantialTask) {
    ctx.plugin.progressService.showProgressModal()
  }

  // --- 发出开始同步事件 ---
  emitStartSync({ showNotice })

  return { confirmedTasks }
}
```

- [ ] **Step 2: Type check + verify primary import**

The confirm stage imports `SyncStartMode` from `'../index'`. Make sure this import works — check that `src/sync/index.ts` exports `SyncStartMode`.

Run: `bun run build 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add src/sync/stages/confirm.stage.ts
git commit -m "refactor: extract confirm stage from NutstoreSync.start()"
```

---

### Task 5: Create execute.stage.ts

**Files:**
- Create: `src/sync/stages/execute.stage.ts`

从 `src/sync/index.ts` 提取：
- Lines 484-506: 分批执行逻辑（chunk → execTasks）
- Lines 594-653: `execTasks` 方法 → 模块内函数
- Lines 659-680: `executeWithRetry` 方法 → 模块内函数
- Lines 682-691: `handle503Error` 方法 → 使用 shared.ts

**Adaptation:** 三个方法从 NutstoreSync private method → module-level function。`this.isCancelled` → `ctx.isCancelled()` 参数。

- [ ] **Step 1: Write execute.stage.ts**

```typescript
import { chunk } from 'lodash-es'
import { emitSyncError, emitSyncProgress } from '~/events'
import i18n from '~/i18n'
import getTaskName from '~/utils/get-task-name'
import { is503Error } from '~/utils/is-503-error'
import logger from '~/utils/logger'
import NoopTask from '../tasks/noop.task'
import CleanRecordTask from '../tasks/clean-record.task'
import { BaseTask, TaskError, TaskResult } from '../tasks/task.interface'
import { handle503Error } from './shared'
import type { SyncContext } from './prepare.stage'

export interface ExecuteOutput {
  allTasksResult: TaskResult[]
}

async function executeWithRetry(
  task: BaseTask,
  isCancelled: () => boolean,
): Promise<TaskResult> {
  while (true) {
    if (isCancelled()) {
      return {
        success: false,
        error: new TaskError(i18n.t('sync.cancelled'), task),
      }
    }
    const taskResult = await task.exec()
    if (!taskResult.success && is503Error(taskResult.error)) {
      await handle503Error(60000, isCancelled)
      if (isCancelled()) {
        return {
          success: false,
          error: new TaskError(i18n.t('sync.cancelled'), task),
        }
      }
      continue
    }
    return taskResult
  }
}

async function execTasks(
  tasks: BaseTask[],
  totalDisplayableTasks: BaseTask[],
  allCompletedTasks: BaseTask[],
  isCancelled: () => boolean,
): Promise<TaskResult[]> {
  const res: TaskResult[] = []
  const tasksToDisplay = tasks.filter(
    (t) => !(t instanceof NoopTask || t instanceof CleanRecordTask),
  )

  logger.debug('Starting to execute sync tasks', {
    totalTasks: tasks.length,
    displayedTasks: tasksToDisplay.length,
    totalDisplayableTasks: totalDisplayableTasks.length,
    alreadyCompleted: allCompletedTasks.length,
  })

  for (let i = 0; i < tasks.length; ++i) {
    const task = tasks[i]
    if (isCancelled()) {
      emitSyncError(new TaskError(i18n.t('sync.cancelled'), task))
      break
    }

    logger.debug(`Executing task [${i + 1}/${tasks.length}] ${task.localPath}`, {
      taskName: getTaskName(task),
      taskPath: task.localPath,
    })

    const taskResult = await executeWithRetry(task, isCancelled)

    logger.debug(`Task completed [${i + 1}/${tasks.length}] ${task.localPath}`, {
      taskName: getTaskName(task),
      taskPath: task.localPath,
      result: taskResult,
    })

    res[i] = taskResult
    if (!(task instanceof NoopTask || task instanceof CleanRecordTask)) {
      allCompletedTasks.push(task)
      emitSyncProgress(totalDisplayableTasks.length, allCompletedTasks)
    }
  }

  const successCount = res.filter((r) => r.success).length
  logger.debug('All tasks execution completed', {
    totalTasks: tasks.length,
    successCount,
    failedCount: tasks.length - successCount,
  })

  return res
}

export async function execute(
  ctx: SyncContext,
  confirmedTasks: BaseTask[],
): Promise<ExecuteOutput> {
  const chunkSize = 200
  const taskChunks = chunk(confirmedTasks, chunkSize)
  const allTasksResult: TaskResult[] = []

  const totalDisplayableTasks = confirmedTasks.filter(
    (t) => !(t instanceof NoopTask || t instanceof CleanRecordTask),
  )

  const allCompletedTasks: BaseTask[] = []

  for (const taskChunk of taskChunks) {
    const chunkResult = await execTasks(
      taskChunk,
      totalDisplayableTasks,
      allCompletedTasks,
      ctx.isCancelled,
    )
    allTasksResult.push(...chunkResult)

    if (ctx.isCancelled()) break
  }

  return { allTasksResult }
}
```

- [ ] **Step 2: Type check**

Run: `bun run build 2>&1 | head -5`

- [ ] **Step 3: Commit**

```bash
git add src/sync/stages/execute.stage.ts
git commit -m "refactor: extract execute stage from NutstoreSync.start()"
```

---

### Task 6: Create finalize.stage.ts

**Files:**
- Create: `src/sync/stages/finalize.stage.ts`

从 `src/sync/index.ts` 提取：
- Lines 508-514: buildNewDB
- Lines 516-546: 记录 sync session
- Lines 548-557: 确保 _sync 目录 + 上传 DB
- Lines 559-560: 保存 lastSyncDB
- Lines 562-581: 失败任务 Modal + emitEndSync
- Lines 582-584: 释放锁

- [ ] **Step 1: Write finalize.stage.ts**

```typescript
import { Notice, normalizePath } from 'obsidian'
import FailedTasksModal, { FailedTaskInfo } from '~/components/FailedTasksModal'
import { emitEndSync } from '~/events'
import i18n from '~/i18n'
import getTaskName from '~/utils/get-task-name'
import logger from '~/utils/logger'
import { saveLastSyncDB } from '../utils/sync-db-persistence'
import { buildNewDB } from '../utils/build-new-db'
import { SyncStartMode } from '../index'
import type { SyncContext, PrepareOutput } from './prepare.stage'
import type { DecideOutput } from './decide.stage'
import type { ConfirmOutput } from './confirm.stage'
import type { ExecuteOutput } from './execute.stage'

export interface FinalizeInput {
  mode: SyncStartMode
  showNotice: boolean
}

export async function finalize(
  ctx: SyncContext,
  prep: PrepareOutput,
  dec: DecideOutput,
  conf: ConfirmOutput,
  exec: ExecuteOutput,
  opts: FinalizeInput,
): Promise<void> {
  const { mode, showNotice } = opts
  const { confirmedTasks } = conf
  const { allTasksResult } = exec

  try {
    // --- Build new DB ---
    const newDB = await buildNewDB(
      prep.localDB,
      prep.remoteDB,
      confirmedTasks,
      allTasksResult,
    )

    // --- Record sync session ---
    let pushCount = 0,
      pullCount = 0,
      removeCount = 0,
      conflictCount = 0
    for (const task of confirmedTasks) {
      const name = task.constructor.name
      if (name.includes('Push')) pushCount++
      else if (name.includes('Pull')) pullCount++
      else if (name.includes('Remove')) removeCount++
      else if (name.includes('Conflict')) conflictCount++
    }

    newDB.insertSyncSession({
      sessionId: prep.sessionId,
      deviceId: prep.deviceId,
      startedAt: prep.startedAt,
      endedAt: Date.now(),
      totalTasks: confirmedTasks.length,
      successCount: allTasksResult.filter((r) => r.success).length,
      failCount: allTasksResult.filter((r) => !r.success).length,
      pushCount,
      pullCount,
      removeCount,
      conflictCount,
      durationMs: Date.now() - prep.startedAt,
      status: allTasksResult.some((r) => !r.success)
        ? 'completed_with_errors'
        : 'completed',
      errorMessage: '',
    })

    // --- Upload DB ---
    try {
      await ctx.webdav.createDirectory(
        `${ctx.remoteBaseDir.replace(/\/$/, '')}/_sync`,
        { recursive: true },
      )
    } catch {
      // _sync 目录可能已存在
    }
    await prep.dbStorage.upload(newDB)

    // --- Save lastSyncDB ---
    await saveLastSyncDB(ctx.vault.getName(), ctx.remoteBaseDir, newDB)

    // --- Failed tasks modal ---
    const failedCount = allTasksResult.filter((r) => !r.success).length
    logger.debug('tasks result', allTasksResult, 'failed:', failedCount)

    if (mode === SyncStartMode.MANUAL_SYNC && failedCount > 0) {
      const failedTasksInfo: FailedTaskInfo[] = []
      for (let i = 0; i < allTasksResult.length; i++) {
        const result = allTasksResult[i]
        if (!result.success && result.error) {
          const task = result.error.task
          failedTasksInfo.push({
            taskName: getTaskName(task),
            localPath: task.options.localPath,
            errorMessage: result.error.message,
          })
        }
      }
      new FailedTasksModal(ctx.plugin.app, failedTasksInfo).open()
    }

    emitEndSync({ failedCount, showNotice })
  } finally {
    await prep.lock.release()
  }
}
```

- [ ] **Step 2: Type check**

Run: `bun run build 2>&1 | head -5`

- [ ] **Step 3: Commit**

```bash
git add src/sync/stages/finalize.stage.ts
git commit -m "refactor: extract finalize stage from NutstoreSync.start()"
```

---

### Task 7: Refactor sync/index.ts

**Files:**
- Modify: `src/sync/index.ts`

这是关键步骤。将 `NutstoreSync` 类缩减为：
1. 保留 `constructor`、getter、`platformLabel`、`isCancelled`、`subscriptions`
2. 新增 `createContext()` 方法构建 `SyncContext`
3. `start()` 替换为编排层代码
4. 删除 `execTasks`、`executeWithRetry`、`handle503Error` 方法
5. 保留公共 API: `SyncStartMode`、`NutstoreSync` class export
6. 精简 imports（删除不再需要的）

**删除的 imports:** `chunk` (lodash-es), `dirname` (path-browserify), `moment`, `normalizePath`, `Subscription`, `DeleteConfirmModal`, `FailedTasksModal` (including type), `TaskListConfirmModal`, `loadEncryptionKey`, `sampleRemoteEncryption`, `SECRET_ID`, `showRestoreKeyModal`, `emitSyncProgress`, `onCancelSync`, `breakableSleep`, `is503Error`, `statVaultItem`, `stdRemotePath`, `computeEffectiveFilterRules`, `SyncDB`, `SyncLock`, `DBStorage`, `CleanRecordTask`, `MkdirRemoteTask`, `NoopTask`, `PushTask`, `RemoveLocalTask`, `SkippedTask`, `BaseTask/TaskError/TaskResult` (depending on usage), `loadLastSyncDB`, `saveLastSyncDB`, `buildNewDB`

**新增的 imports:** stage 函数

- [ ] **Step 1: Write the refactored sync/index.ts**

```typescript
import { Platform, Vault } from 'obsidian'
import { Subscription } from 'rxjs'
import { WebDAVClient } from 'webdav'
import {
  emitEndSync,
  emitPreparingSync,
  emitSyncError,
  onCancelSync,
} from '~/events'
import i18n from '~/i18n'
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

export class NutstoreSync {
  isCancelled: boolean = false

  private subscriptions: Subscription[] = []

  constructor(
    private plugin: NutstorePlugin,
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
        if (prep.lock) {
          await prep.lock.release()
        }
        emitEndSync({ showNotice, failedCount: 0 })
        return
      }

      try {
        const conf = await confirm(ctx, prep, dec, { mode, showNotice })
        if (!conf) return

        const exec = await execute(ctx, conf.confirmedTasks)

        await finalize(ctx, prep, dec, conf, exec, { mode, showNotice })
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

  private get platformLabel(): string {
    if (Platform.isIosApp) return 'ios'
    if (Platform.isAndroidApp) return 'android'
    if (Platform.isDesktopApp) return 'desktop'
    return 'unknown'
  }
}
```

- [ ] **Step 2: Full build check**

Run: `bun run build`
Expected: 编译成功，无类型错误。

- [ ] **Step 3: Run existing tests**

Run: `bun run test`
Expected: 所有现有测试通过（特别是 `src/sync/__tests__/sync-flow.test.ts`）。

- [ ] **Step 4: Commit**

```bash
git add src/sync/index.ts
git commit -m "refactor: replace inline sync logic with pipeline stages"
```

---

## Verification Checklist

After all tasks complete, verify:

```bash
bun run build    # 编译通过
bun run test     # 所有测试通过
git diff main...dev --stat  # 检查变更范围
```

## Rollback

每个 task 都是独立提交。如需回滚到重构前: `git revert <commit>` 逐个 task。
