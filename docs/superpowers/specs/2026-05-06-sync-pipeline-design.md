# Sync Pipeline 重构设计

## 目标

将 `NutstoreSync.start()` 方法 (~500 行) 拆分为 5 个独立阶段，每个阶段一个文件，保持逻辑不变。

## 新增文件

```
src/sync/stages/
├── prepare.stage.ts    # 准备阶段
├── decide.stage.ts     # 决策阶段
├── confirm.stage.ts    # 确认阶段
├── execute.stage.ts    # 执行阶段
└── finalize.stage.ts   # 收尾阶段
```

## 共享上下文

```typescript
interface SyncContext {
  plugin: NutstorePlugin
  vault: Vault
  webdav: WebDAVClient
  remoteBaseDir: string
  settings: NutstoreSettings
  isCancelled: () => boolean
}
```

## 各阶段规格

### Stage 1: prepare

从 `start()` 提取的代码范围: 加密密钥加载、新设备检测、远程目录确保、DB 加载、锁获取、本地扫描。

```
输入: SyncContext, SyncStartMode, showNotice
输出: PrepareOutput | null

PrepareOutput {
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
```

null 返回表示用户取消同步或无密钥。

### Stage 2: decide

从 `start()` 提取的代码范围: TwoWaySyncDecider 创建与执行、noop/skipped 任务分类。

```
输入: SyncContext, PrepareOutput
输出: DecideOutput

DecideOutput {
  allTasks: BaseTask[]
  substantialTasks: BaseTask[]
  noopTasks: BaseTask[]
  skippedTasks: BaseTask[]
}
```

allTasks 数量为 0 时，调用方直接 emitEndSync 并返回。

### Stage 3: confirm

从 `start()` 提取的代码范围: confirmBeforeSync Modal、auto-sync 删除确认 Modal、重上传逻辑。

```
输入: SyncContext, PrepareOutput, DecideOutput, SyncStartMode, showNotice
输出: ConfirmOutput | null

ConfirmOutput {
  confirmedTasks: BaseTask[]
}
```

null 返回表示用户取消。

### Stage 4: execute

从 `start()` 提取的代码范围: 200 个/批、execTasks、503 重试、进度事件。包含现有的 `execTasks()`、`executeWithRetry()`、`handle503Error()` 方法（从 NutstoreSync 移出为模块内函数）。totalDisplayableTasks 在阶段内部从 confirmedTasks 计算。

```
输入: SyncContext, confirmedTasks: BaseTask[]
输出: ExecuteOutput

ExecuteOutput {
  allTasksResult: TaskResult[]
}
```

### Stage 5: finalize

从 `start()` 提取的代码范围: buildNewDB、记录 session、上传 DB、保存 lastSyncDB、释放锁、失败 Modal、emit 事件。

```
输入: SyncContext, PrepareOutput, DecideOutput, ConfirmOutput, ExecuteOutput, showNotice
输出: void
```

副作用: emit 事件、lock.release、subscription cleanup。

## 重构后 NutstoreSync

`start()` 缩减为 ~50 行编排代码:

```typescript
async start({ mode }: { mode: SyncStartMode }) {
  try {
    const showNotice = mode === SyncStartMode.MANUAL_SYNC
    emitPreparingSync({ showNotice })
    const ctx = this.createContext()

    const prep = await prepare(ctx, { mode, showNotice })
    if (!prep) return

    const dec = await decide(ctx, prep)
    if (dec.allTasks.length === 0) {
      emitEndSync({ showNotice, failedCount: 0 })
      return
    }

    const conf = await confirm(ctx, prep, dec, { mode, showNotice })
    if (!conf) return

    const exec = await execute(ctx, conf.confirmedTasks, prep.encryptionKey)
    await finalize(ctx, prep, dec, conf, exec, showNotice)
  } catch (error) {
    emitSyncError(error as Error)
  } finally {
    this.subscriptions.forEach(sub => sub.unsubscribe())
  }
}
```

同时保留:
- `get app/webdav/vault/remoteBaseDir/settings/token/endpoint` 访问器
- `platformLabel` getter
- `isCancelled` 属性
- `createContext()` 新方法 — 构建 SyncContext

## 不变项

- 不修改任何 task 类
- 不修改 TwoWaySyncDecider
- 不修改 crypto/events/services/settings
- 不移除 `handle503Error` — 移至 execute stage 内部
- 不修改测试
- 现有测试预期不变（sync-flow.test.ts 测试 NutstoreSync 公开行为）
