# 同步流程重排序与增量本地扫描 设计文档

## 目标

重新排序同步步骤，将远程状态获取（锁、remoteDB、lastSyncDB）提前到本地扫描之前，并利用 lastSyncDB 的 mtime 信息实现增量本地扫描，减少大 vault 的 SHA-256 计算开销。

## 新同步流程

```
1. 加载加密密钥（不变）
2. 确保远程目录存在（不变）
3. 获取同步锁         ← 从步骤2提前
4. 下载 remoteDB       ← 从步骤3提前
5. 加载 lastSyncDB     ← 从步骤4提前
6. 增量本地扫描        ← 核心变更
7. 决策 (twoWayDecider)
8. 用户确认
9. 分批执行任务
10. 构建新 DB (buildNewDB)
11. 上传新 DB
12. 保存 lastSyncDB
13. 释放锁
```

## 增量本地扫描

### 接口变更

`SyncDB.fromVault()` 新增可选参数：

```typescript
static async fromVault(
  vault: Vault,
  filterRules: FilterRules,
  baseDB?: SyncDB,
): Promise<SyncDB>
```

### 扫描逻辑

遍历每个文件时检查 `baseDB` 中同路径条目：

| 条件 | 行为 |
|------|------|
| mtime 与 baseDB 一致 | 复用 baseDB 的 hash，跳过 readBinary + SHA-256 |
| mtime 不同 | 读取文件内容，重新计算 SHA-256 |
| 新文件（baseDB 无记录） | 读取文件内容，计算 SHA-256 |
| 本地已删除（baseDB 有记录） | 不录入新 DB，decider 检测缺失后生成 RemoveRemote |

目录处理不变，仍然全量收集（目录无 mtime/hash）。

### 调用方变更

`src/sync/index.ts` 中 `NutstoreSync.start()`：

```typescript
// 旧
const localDB = await SyncDB.fromVault(this.vault, { ... })
// ...
const lastSyncDB = await loadLastSyncDB(...)
// ...
const remoteDB = await dbStorage.download()

// 新
// (先获取锁、下载 remoteDB、加载 lastSyncDB)
const localDB = await SyncDB.fromVault(this.vault, { ... }, lastSyncDB)
```

## 加密兼容性

本地文件始终为明文（加密仅发生在 PushTask 上传时，PullTask 下载后解密写入），本地文件 mtime 不受加密影响。增量扫描对加密/非加密文件行为一致，无需特殊处理。

## 错误处理

| 场景 | 处理 |
|------|------|
| lastSyncDB 为空（首次同步） | `baseDB` 为 `undefined`，走全量扫描 |
| mtime 命中但文件损坏 | hash 复用，decider 对比 remote hash 时发现差异触发 Pull/Conflict |
| 同步取消 | `isCancelled` 在循环中检查，中止后续操作 |
| 锁获取失败 | 直接返回错误，本地扫描尚未执行 |

## 测试策略

1. **单元测试：** `SyncDB.fromVault` 增量模式 — mock vault adapter，验证 mtime 命中时跳过 readBinary/sha256，mtime 变更时正常计算
2. **集成测试：** NutstoreSync 完整流程 — 首次同步走全量，二次同步走增量
3. **回归测试：** decider 决策不受增量扫描影响（hash 值一致性）
