# SyncDB Schema Enhancement Design

## 概述

扩展 SyncDB（SQLite）的表结构，增加文件时间维度、设备信息和同步会话摘要，提升可观测性和数据追溯能力。

## 约束

- 继续使用 sql.js（SQLite WASM），不引入新依赖
- 不记录单文件操作日志，不改变加密设计
- 兼容老版本 DB 文件

## 表结构变更

### `files` 表新增字段

```sql
ALTER TABLE files ADD COLUMN first_seen_at INTEGER DEFAULT 0;
ALTER TABLE files ADD COLUMN content_changed_at INTEGER DEFAULT 0;
ALTER TABLE files ADD COLUMN last_synced_at INTEGER DEFAULT 0;
```

| 字段 | 类型 | 含义 | 更新时机 |
|---|---|---|---|
| `first_seen_at` | INTEGER | 文件首次被发现的 Unix 毫秒时间戳 | 文件第一次出现在 vault 时设置，之后不变 |
| `content_changed_at` | INTEGER | 内容实际变更时间 | hash 变化时设置为当前时间；mtime 变但 hash 不变时不动 |
| `last_synced_at` | INTEGER | 最后成功同步时间 | Push/Pull 任务成功后设置为当前时间 |

`mtime` 来自文件系统（可被外部操作改变），`content_changed_at` 仅由插件在检测到 hash 变化时更新，两者独立。

### 新增 `devices` 表

```sql
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  device_name TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  last_online_at INTEGER DEFAULT 0,
  first_seen_at INTEGER DEFAULT 0
);
```

每次同步开始时，用当前设备信息 upsert。遇到 DB 中有已知设备的新记录自动识别。

- `platform` — 从 Obsidian `Platform` API 获取（desktop/mobile/ios/android）
- `device_name` — 从 `Platform.deviceName` 或占位
- `first_seen_at` — 首次发现时设置，之后不变

### 新增 `sync_sessions` 表

```sql
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
  status TEXT NOT NULL DEFAULT 'running',
  error_message TEXT DEFAULT ''
);
```

每个同步周期结束时写入一条聚合摘要。`session_id` 在同步开始时通过 `crypto.randomUUID()` 预分配。只存聚合数字，不存单文件操作记录。

## 关键实现点

### 版本兼容

- DB 版本号从 `'1'` 提升到 `'2'`
- `initSchema` 创建完整的 V2 结构（files 含新字段 + devices + sync_sessions）
- `fromBuffer` 加载老版本 DB 后，检测 `files` 表是否已有新字段，没有则执行 `ALTER TABLE` + 创建新表
- `getAllFiles()` 和 `getFile()` 扩展列选择，包含新字段。老 DB 迁移后列即存在
- `DBFile` 接口扩展新增的三个字段

### 字段更新策略

**`SyncDB.fromVault` 增量扫描** — 文件已存在且有 baseDB 记录时：

```
mtime 不变 → 所有字段保持不变（fast path）
mtime 变 + hash 不变 → 只更新 mtime（外部 touch 等操作）
mtime 变 + hash 变 → 更新 mtime, hash, content_changed_at
新文件 → 设置 first_seen_at, content_changed_at 为当前时间
```

**`buildNewDB` 任务执行后** — 对成功的 Pull/Push 任务，更新对应文件的 `last_synced_at` 为当前时间。

### `buildNewDB` 重构 — 从 remoteDB 启动

当前 `buildNewDB` 从 `localDB`（全新扫描）复制出新 DB：

```ts
const buffer = localDB.toBuffer()
const newDB = await SyncDB.fromBuffer(buffer)
```

这会导致 `devices` 和 `sync_sessions` 表数据在每次同步时丢失——因为 `localDB` 只有当前文件的扫描结果，没有这些共享状态表。

**改为从 `remoteDB` 启动**，将 localDB 的文件信息合并进去：

```ts
// 从 remoteDB 启动，保留所有共享状态（meta/devices/sync_sessions）
const newDB = await SyncDB.fromBuffer(remoteDB.toBuffer())

// 将 localDB 的文件条目合并进 newDB（更新/新增/保留）
for (const f of localDB.getAllFiles()) {
  const existing = newDB.getFile(f.path)
  if (existing) {
    // 已存在 → 更新文件字段，保留 first_seen_at
    newDB.upsertFile({ ...f, first_seen_at: existing.first_seen_at || f.first_seen_at })
  } else {
    // 新文件 → 直接插入
    newDB.upsertFile(f)
  }
}

// 删除 localDB 中不存在的文件（这些文件已在本地被删除）
for (const path of newDB.getAllPaths()) {
  if (!localDB.getFile(path)) {
    newDB.deleteFile(path)
  }
}

// 然后继续原有的任务结果更新逻辑（Pull 后重新计算 hash 等）
```

`remoteDB` 可能为空（首次同步），此时回退到从 `localDB` 创建。

### device_id 来源

`device_id` 已有（由 `lastSyncDB` 维护或首次生成），不需要新增获取逻辑。`devices` 表通过 `SyncDB.deviceId` 获取当前设备 ID 写入。

### devices 表写入时机

每次同步开始时，在 `NutstoreSync.start()` 中获取当前设备信息，写入 `remoteDB`（下载后）。合并后上传到远程。

### sync_sessions 写入

在 `NutstoreSync.start()` 的 Step 8（上传新 DB）之前，统计任务执行结果后写入 `sync_sessions` 记录到 `newDB`。需要从 `allTasksResult` 中按任务类型分类计数。

## 不需要做的

- 不引入新 npm 依赖
- 不修改加密模块
- 不添加外键约束（保持 sql.js 兼容）
- 不暴露老版本 DB 的迁移逻辑——老 DB 直接按新 schema 打开，缺失字段取默认值
