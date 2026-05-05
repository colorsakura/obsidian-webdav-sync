# SyncDB Schema Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 扩展 SyncDB schema，增加 files 表时间字段、devices 表和 sync_sessions 表，重构 buildNewDB 从 remoteDB 启动以保留共享状态。

**Architecture:** 在现有 sql.js SQLite 基础上新增 3 个字段和 2 张表。`fromBuffer` 加载时自动迁移老版本。`buildNewDB` 改为从 `remoteDB` 复制以保留 `devices`/`sync_sessions` 历史数据，文件条目从 `localDB` 合并。

**Tech Stack:** sql.js (SQLite WASM), TypeScript, vitest

---

### Task 1: 扩展 `DBFile` 接口和 DB 方法

**Files:**
- Modify: `src/sync/db/sync-db.ts:28-34`（DBFile 接口）
- Modify: `src/sync/db/sync-db.ts:153-171`（getAllFiles）
- Modify: `src/sync/db/sync-db.ts:173-192`（getFile）

- [ ] **Step 1: 编写失败测试**

Run: `bun test src/sync/db/__tests__/sync-db.test.ts`

现测试应全部通过（无新功能测试），此步骤确认基线。

- [ ] **Step 2: 扩展 `DBFile` 接口**

在 `src/sync/db/sync-db.ts:28-34`，将 DBFile 接口改为：

```ts
export interface DBFile {
  path: string
  mtime: number
  size: number
  hash: string
  isDir: number
  firstSeenAt: number
  contentChangedAt: number
  lastSyncedAt: number
}
```

- [ ] **Step 3: 扩展 `getAllFiles()` 查询列**

在 `src/sync/db/sync-db.ts:153-171`，将 getAllFiles 改为：

```ts
getAllFiles(): DBFile[] {
  const results = this.sqlDb.exec(
    'SELECT path, mtime, size, hash, is_dir, first_seen_at, content_changed_at, last_synced_at FROM files',
  )
  if (results.length === 0) return []
  const { columns, values } = results[0]
  const pathIdx = columns.indexOf('path')
  const mtimeIdx = columns.indexOf('mtime')
  const sizeIdx = columns.indexOf('size')
  const hashIdx = columns.indexOf('hash')
  const isDirIdx = columns.indexOf('is_dir')
  const firstSeenIdx = columns.indexOf('first_seen_at')
  const contentChangedIdx = columns.indexOf('content_changed_at')
  const lastSyncedIdx = columns.indexOf('last_synced_at')
  return values.map((row) => ({
    path: row[pathIdx] as string,
    mtime: row[mtimeIdx] as number,
    size: row[sizeIdx] as number,
    hash: row[hashIdx] as string,
    isDir: row[isDirIdx] as number,
    firstSeenAt: (row[firstSeenIdx] as number) ?? 0,
    contentChangedAt: (row[contentChangedIdx] as number) ?? 0,
    lastSyncedAt: (row[lastSyncedIdx] as number) ?? 0,
  }))
}
```

- [ ] **Step 4: 扩展 `getFile()` 查询列**

在 `src/sync/db/sync-db.ts:173-192`，将 getFile 改为：

```ts
getFile(path: string): DBFile | undefined {
  const stmt = this.sqlDb.prepare(
    'SELECT path, mtime, size, hash, is_dir, first_seen_at, content_changed_at, last_synced_at FROM files WHERE path = ?',
  )
  stmt.bind([path])
  if (stmt.step()) {
    const cols = stmt.getColumnNames()
    const vals = stmt.get()
    stmt.free()
    const v = (col: string) => vals[cols.indexOf(col)] as number | undefined
    return {
      path: vals[cols.indexOf('path')] as string,
      mtime: vals[cols.indexOf('mtime')] as number,
      size: vals[cols.indexOf('size')] as number,
      hash: vals[cols.indexOf('hash')] as string,
      isDir: vals[cols.indexOf('is_dir')] as number,
      firstSeenAt: v('first_seen_at') ?? 0,
      contentChangedAt: v('content_changed_at') ?? 0,
      lastSyncedAt: v('last_synced_at') ?? 0,
    }
  }
  stmt.free()
  return undefined
}
```

- [ ] **Step 5: 运行现有测试确认兼容**

```bash
bun test src/sync/db/__tests__/sync-db.test.ts
```

预期：现有测试可能因 INSERT 缺少新字段而失败，下一任务处理。

- [ ] **Step 6: 提交**

```bash
git add src/sync/db/sync-db.ts
git commit -m "feat: extend DBFile interface with time dimension fields"
```

---

### Task 2: V2 Schema + 迁移逻辑

**Files:**
- Modify: `src/sync/db/sync-db.ts:238-253`（initSchema）
- Modify: `src/sync/db/sync-db.ts:200-208`（upsertFile）
- Modify: `src/sync/db/sync-db.ts:125-136`（fromBuffer 添加迁移）

- [ ] **Step 1: 更新 `initSchema` 为 V2**

在 `src/sync/db/sync-db.ts:238-253`，替换 initSchema：

```ts
private static initSchema(db: SqlJsDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      hash TEXT NOT NULL,
      is_dir INTEGER DEFAULT 0,
      first_seen_at INTEGER DEFAULT 0,
      content_changed_at INTEGER DEFAULT 0,
      last_synced_at INTEGER DEFAULT 0
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      device_name TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT '',
      last_online_at INTEGER DEFAULT 0,
      first_seen_at INTEGER DEFAULT 0
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS sync_sessions (
      session_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER DEFAULT 0,
      total_tasks INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      fail_count INTEGER DEFAULT 0,
      push_count INTEGER DEFAULT 0,
      pull_count INTEGER DEFAULT 0,
      remove_count INTEGER DEFAULT 0,
      conflict_count INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'completed',
      error_message TEXT DEFAULT ''
    )
  `)
}
```

- [ ] **Step 2: 更新 `upsertFile` 包含新字段**

在 `src/sync/db/sync-db.ts:200-208`，替换 upsertFile：

```ts
upsertFile(file: DBFile): void {
  this.sqlDb.run(
    'INSERT OR REPLACE INTO files (path, mtime, size, hash, is_dir, first_seen_at, content_changed_at, last_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [file.path, file.mtime, file.size, file.hash, file.isDir, file.firstSeenAt, file.contentChangedAt, file.lastSyncedAt],
  )
}
```

- [ ] **Step 3: 在 `fromBuffer` 添加自动迁移**

在 `src/sync/db/sync-db.ts:125-136`，在返回 new SyncDB 之前插入迁移逻辑。将方法改为：

```ts
static async fromBuffer(buffer: ArrayBuffer): Promise<SyncDB> {
  const sql = await getSql()
  try {
    const db = new sql.Database(new Uint8Array(buffer))
    db.exec('SELECT count(*) FROM sqlite_master')
    SyncDB.migrateIfNeeded(db)
    return new SyncDB(db)
  } catch (err) {
    throw new Error(
      'Failed to load SyncDB from buffer: invalid or corrupt SQLite data',
    )
  }
}
```

在类中添加私有静态方法 migration，放在 initSchema 之后（约第 256 行）：

```ts
private static migrateIfNeeded(db: SqlJsDatabase): void {
  // 检测 files 表是否有新字段
  const cols = db.exec('PRAGMA table_info(files)')
  if (cols.length > 0) {
    const columnNames = cols[0].values.map((r) => r[1] as string)
    if (!columnNames.includes('first_seen_at')) {
      db.run('ALTER TABLE files ADD COLUMN first_seen_at INTEGER DEFAULT 0')
    }
    if (!columnNames.includes('content_changed_at')) {
      db.run('ALTER TABLE files ADD COLUMN content_changed_at INTEGER DEFAULT 0')
    }
    if (!columnNames.includes('last_synced_at')) {
      db.run('ALTER TABLE files ADD COLUMN last_synced_at INTEGER DEFAULT 0')
    }
  }

  // 检测并创建 devices 表
  const deviceTable = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='devices'")
  if (deviceTable.length === 0 || deviceTable[0].values.length === 0) {
    db.run(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        device_name TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL DEFAULT '',
        last_online_at INTEGER DEFAULT 0,
        first_seen_at INTEGER DEFAULT 0
      )
    `)
  }

  // 检测并创建 sync_sessions 表
  const sessionsTable = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_sessions'")
  if (sessionsTable.length === 0 || sessionsTable[0].values.length === 0) {
    db.run(`
      CREATE TABLE IF NOT EXISTS sync_sessions (
        session_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER DEFAULT 0,
        total_tasks INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        push_count INTEGER DEFAULT 0,
        pull_count INTEGER DEFAULT 0,
        remove_count INTEGER DEFAULT 0,
        conflict_count INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'completed',
        error_message TEXT DEFAULT ''
      )
    `)
  }

  // 更新版本标记
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('version', '2')")
}
```

- [ ] **Step 4: 运行测试确认**

```bash
bun test src/sync/db/__tests__/sync-db.test.ts
```

预期：现有测试全部通过（旧字段访问逻辑不变），INSERT 适配新列数。

- [ ] **Step 5: 提交**

```bash
git add src/sync/db/sync-db.ts
git commit -m "feat: add V2 schema with devices and sync_sessions tables"
```

---

### Task 3: devices 和 sync_sessions 的 CRUD 方法

**Files:**
- Modify: `src/sync/db/sync-db.ts`（添加新方法）

- [ ] **Step 1: 添加 devices 相关方法**

在 `src/sync/db/sync-db.ts` 的 `deleteFile` 方法之后（约第 209 行），添加：

```ts
upsertDevice(device: { deviceId: string; deviceName: string; platform: string; lastOnlineAt: number; firstSeenAt: number }): void {
  const existing = this.getDevice(device.deviceId)
  this.sqlDb.run(
    'INSERT OR REPLACE INTO devices (device_id, device_name, platform, last_online_at, first_seen_at) VALUES (?, ?, ?, ?, ?)',
    [
      device.deviceId,
      device.deviceName,
      device.platform,
      device.lastOnlineAt,
      existing ? existing.firstSeenAt : device.firstSeenAt,
    ],
  )
}

getDevice(deviceId: string): { deviceId: string; deviceName: string; platform: string; lastOnlineAt: number; firstSeenAt: number } | undefined {
  const stmt = this.sqlDb.prepare('SELECT device_id, device_name, platform, last_online_at, first_seen_at FROM devices WHERE device_id = ?')
  stmt.bind([deviceId])
  if (stmt.step()) {
    const cols = stmt.getColumnNames()
    const vals = stmt.get()
    stmt.free()
    const v = (col: string) => vals[cols.indexOf(col)]
    return {
      deviceId: v('device_id') as string,
      deviceName: v('device_name') as string,
      platform: v('platform') as string,
      lastOnlineAt: v('last_online_at') as number,
      firstSeenAt: v('first_seen_at') as number,
    }
  }
  stmt.free()
  return undefined
}

getAllDevices(): { deviceId: string; deviceName: string; platform: string; lastOnlineAt: number; firstSeenAt: number }[] {
  const results = this.sqlDb.exec('SELECT device_id, device_name, platform, last_online_at, first_seen_at FROM devices')
  if (results.length === 0) return []
  const { columns, values } = results[0]
  return values.map((row) => ({
    deviceId: row[columns.indexOf('device_id')] as string,
    deviceName: row[columns.indexOf('device_name')] as string,
    platform: row[columns.indexOf('platform')] as string,
    lastOnlineAt: row[columns.indexOf('last_online_at')] as number,
    firstSeenAt: row[columns.indexOf('first_seen_at')] as number,
  }))
}
```

- [ ] **Step 2: 添加 sync_sessions 相关方法**

在上面 devices 方法之后继续添加：

```ts
insertSyncSession(session: {
  sessionId: string
  deviceId: string
  startedAt: number
  endedAt: number
  totalTasks: number
  successCount: number
  failCount: number
  pushCount: number
  pullCount: number
  removeCount: number
  conflictCount: number
  durationMs: number
  status: string
  errorMessage: string
}): void {
  this.sqlDb.run(
    `INSERT INTO sync_sessions (session_id, device_id, started_at, ended_at, total_tasks, success_count, fail_count, push_count, pull_count, remove_count, conflict_count, duration_ms, status, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      session.sessionId,
      session.deviceId,
      session.startedAt,
      session.endedAt,
      session.totalTasks,
      session.successCount,
      session.failCount,
      session.pushCount,
      session.pullCount,
      session.removeCount,
      session.conflictCount,
      session.durationMs,
      session.status,
      session.errorMessage,
    ],
  )
}
```

- [ ] **Step 3: 运行测试确认编译通过**

```bash
bun test src/sync/db/__tests__/sync-db.test.ts
```

- [ ] **Step 4: 提交**

```bash
git add src/sync/db/sync-db.ts
git commit -m "feat: add devices and sync_sessions CRUD methods"
```

---

### Task 4: fromVault 填充新时间字段

**Files:**
- Modify: `src/sync/db/sync-db.ts:44-123`（fromVault 方法）

- [ ] **Step 1: 更新 fromVault 文件插入逻辑，填充时间字段**

在 `src/sync/db/sync-db.ts` 的 `fromVault` 方法中，找到 insertStmt 准备和文件处理循环（约第 69-113 行）。

替换 insertStmt 准备语句（第 69-72 行）：

```ts
const insertStmt = db.prepare(
  'INSERT OR REPLACE INTO files (path, mtime, size, hash, is_dir, first_seen_at, content_changed_at, last_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
)
```

替换文件处理循环中的 insert 调用（第 112 行附近）：

```ts
// 处理文件
for (const filePath of files) {
  if (!isIncluded(filePath)) continue
  const stat = await vault.adapter.stat(filePath)
  const mtime = stat?.mtime ?? 0
  const size = stat?.size ?? 0

  const baseFile = baseDB?.getFile(filePath)
  let hash: string
  let firstSeenAt: number
  let contentChangedAt: number

  if (baseFile) {
    firstSeenAt = baseFile.firstSeenAt
    if (baseFile.mtime === mtime) {
      hash = baseFile.hash
      contentChangedAt = baseFile.contentChangedAt
    } else {
      const content = await vault.adapter.readBinary(filePath)
      hash = await sha256Hex(content)
      if (hash !== baseFile.hash) {
        contentChangedAt = Date.now()
      } else {
        contentChangedAt = baseFile.contentChangedAt
      }
    }
  } else {
    firstSeenAt = Date.now()
    contentChangedAt = Date.now()
    const content = await vault.adapter.readBinary(filePath)
    hash = await sha256Hex(content)
  }

  insertStmt.run([filePath, mtime, size, hash, 0, firstSeenAt, contentChangedAt, 0])
}
```

替换目录插入（第 117-119 行）：

```ts
for (const folder of allFolders) {
  insertStmt.run([folder, 0, 0, '', 1, Date.now(), 0, 0])
}
```

- [ ] **Step 2: 运行现有测试**

```bash
bun test src/sync/db/__tests__/sync-db.test.ts
```

预期：现有测试需要更新（mock helper 中的 upsert 仍用旧签名），下一任务统一修测试。

- [ ] **Step 3: 提交**

```bash
git add src/sync/db/sync-db.ts
git commit -m "feat: populate first_seen_at and content_changed_at in fromVault"
```

---

### Task 5: buildNewDB 重构 + 时间字段更新

**Files:**
- Modify: `src/sync/utils/build-new-db.ts`（完全重写）

- [ ] **Step 1: 重写 buildNewDB**

将 `src/sync/utils/build-new-db.ts` 替换为：

```ts
import { sha256Hex } from '~/utils/sha256'
import { SyncDB } from '../db/sync-db'
import type { BaseTask, TaskResult } from '../tasks/task.interface'

export async function buildNewDB(
  localDB: SyncDB,
  remoteDB: SyncDB,
  tasks: BaseTask[],
  results: TaskResult[],
): Promise<SyncDB> {
  // 从 remoteDB 启动，保留共享状态（meta/devices/sync_sessions/files 历史）
  const remoteFiles = remoteDB.getAllFiles()
  const hasRemoteState = remoteFiles.length > 0

  let newDB: SyncDB
  if (hasRemoteState) {
    const buffer = remoteDB.toBuffer()
    newDB = await SyncDB.fromBuffer(buffer)

    // 由 remoteDB → localDB 同步文件条目
    for (const f of localDB.getAllFiles()) {
      const existing = newDB.getFile(f.path)
      if (existing) {
        newDB.upsertFile({
          ...f,
          firstSeenAt: existing.firstSeenAt || f.firstSeenAt,
        })
      } else {
        newDB.upsertFile(f)
      }
    }

    // 删除 localDB 中不存在的文件
    const localPaths = new Set(localDB.getAllFiles().map((f) => f.path))
    for (const p of newDB.getAllPaths()) {
      if (!localPaths.has(p)) {
        newDB.deleteFile(p)
      }
    }
  } else {
    const buffer = localDB.toBuffer()
    newDB = await SyncDB.fromBuffer(buffer)
  }

  // 应用任务执行结果
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]
    const result = results[i]
    if (!result?.success) continue

    const taskName = task.constructor.name
    const path = task.remotePath || task.localPath
    const now = Date.now()

    if (taskName.includes('RemoveLocal') || taskName.includes('RemoveRemote')) {
      newDB.deleteFile(path)
    } else if (taskName.includes('Pull')) {
      try {
        const content = await task.vault.adapter.readBinary(task.localPath)
        const hash = await sha256Hex(content)
        const stat = await task.vault.adapter.stat(task.localPath)
        const existing = newDB.getFile(task.localPath)
        newDB.upsertFile({
          path: task.localPath,
          mtime: stat?.mtime ?? 0,
          size: stat?.size ?? 0,
          hash,
          isDir: 0,
          firstSeenAt: existing?.firstSeenAt ?? now,
          contentChangedAt: now,
          lastSyncedAt: now,
        })
      } catch {
        // 如果 Pull 后无法读取文件，保留旧条目
      }
    } else if (taskName.includes('Push') || taskName.includes('ConflictResolve')) {
      const existing = newDB.getFile(path)
      if (existing) {
        newDB.upsertFile({
          ...existing,
          lastSyncedAt: now,
        })
      }
    } else if (taskName.includes('MkdirLocal')) {
      newDB.upsertFile({
        path: task.localPath,
        mtime: 0,
        size: 0,
        hash: '',
        isDir: 1,
        firstSeenAt: now,
        contentChangedAt: 0,
        lastSyncedAt: now,
      })
    } else if (taskName.includes('Noop')) {
      const existing = newDB.getFile(path)
      if (existing) {
        newDB.upsertFile({
          ...existing,
          lastSyncedAt: now,
        })
      }
    }
  }

  // Bump version
  const newVersion = (await (async () => {
    const v = remoteDB.version
    return isNaN(v) ? 1 : v
  })()) + 1
  newDB.setMeta('version', String(newVersion))
  newDB.setMeta('updated_at', String(Date.now()))

  return newDB
}
```

- [ ] **Step 2: 更新 buildNewDB 调用签名**

`src/sync/index.ts:497` 当前调用 `buildNewDB(localDB, confirmedTasks, allTasksResult)`，需要改为 `buildNewDB(localDB, remoteDB, confirmedTasks, allTasksResult)`。

- [ ] **Step 3: 运行测试确认编译**

```bash
bun test src/sync/utils/
```

- [ ] **Step 4: 提交**

```bash
git add src/sync/utils/build-new-db.ts src/sync/index.ts
git commit -m "refactor: buildNewDB starts from remoteDB to preserve shared state"
```

---

### Task 6: NutstoreSync 集成 — 写入 devices 和 sync_sessions

**Files:**
- Modify: `src/sync/index.ts:168-208`（同步流程 Step 1-5 区域）

- [ ] **Step 1: 在同步开始时写入当前设备信息**

在 `src/sync/index.ts` 的 NutstoreSync.start() 方法中，在获取 deviceId 之后、lock 获取之后、remoteDB 下载完成后，插入设备信息写入。

找到约第 188 行（`const downloadedDB = await dbStorage.download()` 之后，`let remoteDB: SyncDB` 赋值之后），在 remoteDB 确定后写入设备信息。

在 NutstoreSync 类中添加私有辅助方法（约第 660 行，get endpoint 之后）：

```ts
private get platformLabel(): string {
  if (Platform.isIosApp) return 'ios'
  if (Platform.isAndroidApp) return 'android'
  if (Platform.isDesktopApp) return 'desktop'
  return 'unknown'
}
```

然后在 remoteDB 下载并赋值后（约第 200 行之后），添加设备 upsert。找到 `let remoteDB: SyncDB` 的 if/else 块结束位置（约第 198 行后），添加：

```ts
// 写入当前设备信息
const currentTime = Date.now()
remoteDB.upsertDevice({
  deviceId,
  deviceName: '',
  platform: this.platformLabel,
  lastOnlineAt: currentTime,
  firstSeenAt: currentTime,
})
```

- [ ] **Step 2: 在同步结束时写入 sync_sessions 记录**

在 `src/sync/index.ts` 中，找到 Step 8（上传 DB）之前的代码区域（约第 496 行 `const newDB = await buildNewDB(localDB, confirmedTasks, allTasksResult)` 之后），插入 session 写入。

需要在同步开始时记录 `sessionId` 和 `startedAt`。在 `NutstoreSync.start()` 方法开头附近（Step 1 之前），添加：

```ts
const sessionId = crypto.randomUUID()
const startedAt = Date.now()
```

然后在 `const newDB = await buildNewDB(...)` 之后（约第 498 行）：

```ts
// 统计任务类型
let pushCount = 0, pullCount = 0, removeCount = 0, conflictCount = 0
for (const task of confirmedTasks) {
  const name = task.constructor.name
  if (name.includes('Push')) pushCount++
  else if (name.includes('Pull')) pullCount++
  else if (name.includes('Remove')) removeCount++
  else if (name.includes('Conflict')) conflictCount++
}

newDB.insertSyncSession({
  sessionId,
  deviceId,
  startedAt,
  endedAt: Date.now(),
  totalTasks: confirmedTasks.length,
  successCount: allTasksResult.filter((r) => r.success).length,
  failCount: allTasksResult.filter((r) => !r.success).length,
  pushCount,
  pullCount,
  removeCount,
  conflictCount,
  durationMs: Date.now() - startedAt,
  status: allTasksResult.some((r) => !r.success) ? 'completed_with_errors' : 'completed',
  errorMessage: '',
})
```

- [ ] **Step 3: 确认编译和现有测试**

```bash
bun run build
bun test
```

- [ ] **Step 4: 提交**

```bash
git add src/sync/index.ts
git commit -m "feat: record devices and sync_sessions during sync cycle"
```

---

### Task 7: 更新测试 — 新增字段兼容

**Files:**
- Modify: `src/sync/db/__tests__/sync-db.test.ts`

- [ ] **Step 1: 更新现有测试中的 upsertFile 调用，补充新字段**

在测试文件中，找到所有 `upsertFile` 调用，为每个添加 `firstSeenAt: 0, contentChangedAt: 0, lastSyncedAt: 0`。

例如第 51-57 行改为：

```ts
baseDB.upsertFile({
  path: 'note.md',
  mtime: 1000,
  size: 999,
  hash: 'a'.repeat(64),
  isDir: 0,
  firstSeenAt: 0,
  contentChangedAt: 0,
  lastSyncedAt: 0,
})
```

对所有 `upsertFile` 调用做同样修改（约 5 处）。

- [ ] **Step 2: 添加新字段的验证测试**

在 `describe('fromVault')` 块末尾，添加测试：

```ts
it('新文件应有 firstSeenAt 和 contentChangedAt', async () => {
  const mockVault = createMockVault({
    'new.md': { content: 'fresh', mtime: 1000 },
  })

  const db = await SyncDB.fromVault(mockVault, mockFilterRules)

  const file = db.getFile('new.md')!
  expect(file.firstSeenAt).toBeGreaterThan(0)
  expect(file.contentChangedAt).toBeGreaterThan(0)
  expect(file.lastSyncedAt).toBe(0)
})

it('mtime 不变时复用 baseDB 的时间字段', async () => {
  const baseDB = await SyncDB.empty('device-1')
  baseDB.upsertFile({
    path: 'old.md',
    mtime: 1000,
    size: 5,
    hash: 'a'.repeat(64),
    isDir: 0,
    firstSeenAt: 900,
    contentChangedAt: 950,
    lastSyncedAt: 0,
  })

  const mockVault = createMockVault({
    'old.md': { content: 'hello', mtime: 1000 },
  })

  const db = await SyncDB.fromVault(mockVault, mockFilterRules, baseDB)

  const file = db.getFile('old.md')!
  expect(file.hash).toBe('a'.repeat(64))
  expect(file.firstSeenAt).toBe(900)
  expect(file.contentChangedAt).toBe(950)
})

it('mtime 变但 hash 不变时不应更新 contentChangedAt', async () => {
  const baseDB = await SyncDB.empty('device-1')
  baseDB.upsertFile({
    path: 'touch.md',
    mtime: 1000,
    size: 5,
    hash: 'a'.repeat(64),
    isDir: 0,
    firstSeenAt: 800,
    contentChangedAt: 900,
    lastSyncedAt: 0,
  })

  const mockVault = createMockVault({
    'touch.md': { content: 'hello', mtime: 2000 },
  })

  const db = await SyncDB.fromVault(mockVault, mockFilterRules, baseDB)

  const file = db.getFile('touch.md')!
  expect(file.mtime).toBe(2000)
  expect(file.hash).toBe('a'.repeat(64))
  expect(file.contentChangedAt).toBe(900)
})

it('db.version 在 fromBuffer 迁移后应为 2', async () => {
  // 创建 v1 DB
  const oldDB = await SyncDB.empty('dev-1')
  const buffer = oldDB.toBuffer()

  const loaded = await SyncDB.fromBuffer(buffer)
  expect(loaded.version).toBe(2)
})
```

- [ ] **Step 3: 添加 devices CRUD 测试**

在 `describe('SyncDB')` 块内，添加新的 describe 块：

```ts
describe('devices', () => {
  it('应能 upsert 和查询设备', async () => {
    const db = await SyncDB.empty('device-1')

    db.upsertDevice({
      deviceId: 'dev-a',
      deviceName: 'My Desktop',
      platform: 'desktop',
      lastOnlineAt: 1000,
      firstSeenAt: 900,
    })

    const device = db.getDevice('dev-a')!
    expect(device.deviceId).toBe('dev-a')
    expect(device.deviceName).toBe('My Desktop')
    expect(device.platform).toBe('desktop')
  })

  it('upsert 已有设备应保留 firstSeenAt', async () => {
    const db = await SyncDB.empty('device-1')

    db.upsertDevice({
      deviceId: 'dev-a',
      deviceName: 'Desktop',
      platform: 'desktop',
      lastOnlineAt: 1000,
      firstSeenAt: 900,
    })

    db.upsertDevice({
      deviceId: 'dev-a',
      deviceName: 'Desktop Updated',
      platform: 'desktop',
      lastOnlineAt: 2000,
      firstSeenAt: 9999,
    })

    const device = db.getDevice('dev-a')!
    expect(device.firstSeenAt).toBe(900)
    expect(device.lastOnlineAt).toBe(2000)
    expect(device.deviceName).toBe('Desktop Updated')
  })

  it('getAllDevices 应返回所有设备', async () => {
    const db = await SyncDB.empty('device-1')
    db.upsertDevice({ deviceId: 'a', deviceName: '', platform: '', lastOnlineAt: 0, firstSeenAt: 0 })
    db.upsertDevice({ deviceId: 'b', deviceName: '', platform: '', lastOnlineAt: 0, firstSeenAt: 0 })

    expect(db.getAllDevices()).toHaveLength(2)
  })
})
```

- [ ] **Step 4: 添加 fromBuffer 迁移测试**

在上述 devices describe 之后添加：

```ts
describe('migration', () => {
  it('fromBuffer 应自动为老 DB 添加新字段和新表', async () => {
    const db = await SyncDB.empty('dev-1')
    db.upsertFile({ path: 'f.md', mtime: 1, size: 1, hash: 'a'.repeat(64), isDir: 0, firstSeenAt: 0, contentChangedAt: 0, lastSyncedAt: 0 })
    db.upsertDevice({ deviceId: 'dev-1', deviceName: '', platform: '', lastOnlineAt: 0, firstSeenAt: 0 })

    const buffer = db.toBuffer()
    const loaded = await SyncDB.fromBuffer(buffer)

    const file = loaded.getFile('f.md')!
    expect(file.firstSeenAt).toBeDefined()
    expect(loaded.getDevice('dev-1')).toBeDefined()
  })
})
```

- [ ] **Step 5: 运行所有测试**

```bash
bun test src/sync/db/__tests__/sync-db.test.ts
```

预期全部通过。

- [ ] **Step 6: 提交**

```bash
git add src/sync/db/__tests__/sync-db.test.ts
git commit -m "test: update tests for new time fields, devices, and migration"
```

---

### Task 8: 全量测试 + typecheck

**Files:** 无新建

- [ ] **Step 1: 运行完整测试套件**

```bash
bun test
```

预期：所有测试通过。

- [ ] **Step 2: 运行构建（含 typecheck）**

```bash
bun run build
```

预期：构建成功，无类型错误。

- [ ] **Step 3: 提交（如有修正确认）**

```bash
git add -A
git commit -m "chore: fix test and type errors after schema enhancement"
```
