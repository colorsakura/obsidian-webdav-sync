# 同步流程重排序与增量本地扫描 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重排同步步骤（先远程后本地），利用 lastSyncDB 的 mtime 实现增量本地扫描，跳过未变文件的 SHA-256 计算。

**Architecture:** 在 `SyncDB.fromVault` 新增 `baseDB` 参数，遍历文件时先对比 mtime，命中则复用 hash。`NutstoreSync.start()` 中将 lastSyncDB 加载、锁获取、remoteDB 下载移至本地扫描之前，扫描时传入 lastSyncDB。

**Tech Stack:** TypeScript, vitest, Obsidian API

---

### Task 1: 为 SyncDB.fromVault 添加 baseDB 参数和增量逻辑

**Files:**
- Modify: `src/sync/db/sync-db.ts:44-112`

- [ ] **Step 1: 修改 fromVault 签名，添加可选 baseDB 参数**

```typescript
// 将第 44 行的方法签名从:
static async fromVault(
  vault: Vault,
  filterRules: FilterRules,
): Promise<SyncDB> {

// 改为:
static async fromVault(
  vault: Vault,
  filterRules: FilterRules,
  baseDB?: SyncDB,
): Promise<SyncDB> {
```

- [ ] **Step 2: 替换文件处理循环，加入 mtime 比对逻辑**

将第 96-102 行:
```typescript
for (const filePath of files) {
  if (!isIncluded(filePath)) continue
  const content = await vault.adapter.readBinary(filePath)
  const stat = await vault.adapter.stat(filePath)
  const hash = await sha256Hex(content)
  insertStmt.run([filePath, stat?.mtime ?? 0, stat?.size ?? 0, hash, 0])
}
```

替换为:
```typescript
for (const filePath of files) {
  if (!isIncluded(filePath)) continue
  const stat = await vault.adapter.stat(filePath)
  const mtime = stat?.mtime ?? 0
  const size = stat?.size ?? 0

  const baseFile = baseDB?.getFile(filePath)
  let hash: string
  if (baseFile && baseFile.mtime === mtime) {
    hash = baseFile.hash
  } else {
    const content = await vault.adapter.readBinary(filePath)
    hash = await sha256Hex(content)
  }

  insertStmt.run([filePath, mtime, size, hash, 0])
}
```

- [ ] **Step 3: 编译验证**

```bash
bun run build
```

Expected: 构建成功，无类型错误。

- [ ] **Step 4: 提交**

```bash
git add src/sync/db/sync-db.ts
git commit -m "feat: add baseDB param to SyncDB.fromVault for incremental scan

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: 为增量扫描添加单元测试

**Files:**
- Modify: `src/sync/db/__tests__/sync-db.test.ts`

- [ ] **Step 1: 添加增量扫描测试用例**

在 `describe('fromVault', () => {` 块的末尾（第 47 行 `})` 之前）添加以下测试:

```typescript
describe('增量扫描 (baseDB)', () => {
  it('mtime 相同时应复用 baseDB 的 hash，不调用 readBinary', async () => {
    // 准备 baseDB（模拟上次同步后的状态）
    const baseDB = await SyncDB.empty('device-1')
    baseDB.upsertFile({
      path: 'note.md',
      mtime: 1000,
      size: 5,
      hash: 'a'.repeat(64),
      isDir: 0,
    })

    const mockVault = createMockVault({
      'note.md': { content: 'hello', mtime: 1000 },
    })

    const db = await SyncDB.fromVault(mockVault, mockFilterRules, baseDB)

    // 验证 hash 被复用
    const file = db.getFile('note.md')!
    expect(file.hash).toBe('a'.repeat(64))
    // readBinary 不应被调用（因为 mtime 匹配）
    // 注：当前 mock 的实现无法精确断言调用次数，此测试通过 hash 值间接验证
  })

  it('mtime 不同时应重新计算 hash', async () => {
    const baseDB = await SyncDB.empty('device-1')
    baseDB.upsertFile({
      path: 'note.md',
      mtime: 1000,
      size: 5,
      hash: 'a'.repeat(64),
      isDir: 0,
    })

    const mockVault = createMockVault({
      'note.md': { content: 'hello world', mtime: 2000 },
    })

    const db = await SyncDB.fromVault(mockVault, mockFilterRules, baseDB)

    const file = db.getFile('note.md')!
    // hash 应为重新计算的值，而非 baseDB 的值
    expect(file.hash).not.toBe('a'.repeat(64))
    expect(file.hash).toHaveLength(64)
    expect(file.mtime).toBe(2000)
  })

  it('新文件（baseDB 无记录）应正常计算 hash', async () => {
    const baseDB = await SyncDB.empty('device-1')
    // baseDB 中有旧文件，但没有新文件
    baseDB.upsertFile({
      path: 'old.md',
      mtime: 1000,
      size: 5,
      hash: 'b'.repeat(64),
      isDir: 0,
    })

    const mockVault = createMockVault({
      'old.md': { content: 'old', mtime: 1000 },
      'new.md': { content: 'new file here', mtime: 1100 },
    })

    const db = await SyncDB.fromVault(mockVault, mockFilterRules, baseDB)

    // 旧文件复用 hash
    expect(db.getFile('old.md')!.hash).toBe('b'.repeat(64))
    // 新文件正常计算
    const newFile = db.getFile('new.md')!
    expect(newFile.hash).toHaveLength(64)
    expect(newFile.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('无 baseDB 时应全量计算（兼容旧行为）', async () => {
    const mockVault = createMockVault({
      'note.md': { content: 'hello', mtime: 1000 },
    })

    const db = await SyncDB.fromVault(mockVault, mockFilterRules)

    const file = db.getFile('note.md')!
    expect(file.hash).toHaveLength(64)
    expect(file.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('多个文件混合场景：部分复用、部分重新计算', async () => {
    const baseDB = await SyncDB.empty('device-1')
    baseDB.upsertFile({
      path: 'unchanged.md',
      mtime: 1000,
      size: 7,
      hash: 'a'.repeat(64),
      isDir: 0,
    })
    baseDB.upsertFile({
      path: 'changed.md',
      mtime: 1000,
      size: 4,
      hash: 'b'.repeat(64),
      isDir: 0,
    })

    const mockVault = createMockVault({
      'unchanged.md': { content: 'nothing', mtime: 1000 },
      'changed.md': { content: 'changed!', mtime: 2000 },
      'new.md': { content: 'new file', mtime: 1100 },
    })

    const db = await SyncDB.fromVault(mockVault, mockFilterRules, baseDB)

    // 未变文件复用 hash
    expect(db.getFile('unchanged.md')!.hash).toBe('a'.repeat(64))
    // 已变文件重新计算
    expect(db.getFile('changed.md')!.hash).not.toBe('b'.repeat(64))
    expect(db.getFile('changed.md')!.hash).toHaveLength(64)
    // 新文件正常计算
    expect(db.getFile('new.md')!.hash).toHaveLength(64)
    expect(db.getFile('new.md')!.hash).toMatch(/^[0-9a-f]{64}$/)
  })
})
```

- [ ] **Step 2: 运行新增测试**

```bash
bun test src/sync/db/__tests__/sync-db.test.ts
```

Expected: 所有测试通过（包括原有的 8 个 + 新增的 5 个，共 13 个）。

- [ ] **Step 3: 运行全部测试确保无回归**

```bash
bun run test
```

Expected: 全部测试通过。

- [ ] **Step 4: 提交**

```bash
git add src/sync/db/__tests__/sync-db.test.ts
git commit -m "test: add incremental scan tests for SyncDB.fromVault baseDB

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: 重排 NutstoreSync.start() 同步步骤

**Files:**
- Modify: `src/sync/index.ts:167-197`

- [ ] **Step 1: 删除原来的 Step 1-4 代码块**

删除第 167-197 行:
```typescript
// Step 1: Local scan
const localDB = await SyncDB.fromVault(this.vault, {
  exclude: filterRules.exclusionRules,
  include: filterRules.inclusionRules,
})
const deviceId = localDB.deviceId

// Step 2: Acquire lock
const lock = new SyncLock(webdav, remoteBaseDir, deviceId)
const locked = await lock.acquire()
if (!locked) {
  emitSyncError(new Error('无法获取同步锁，请稍后重试'))
  return
}

try {
  // Step 3: Download remote DB
  const dbStorage = new DBStorage(webdav, remoteBaseDir)
  let remoteDB = await dbStorage.download()
  if (!remoteDB) {
    remoteDB = await SyncDB.empty('remote')
  }

  // Step 4: Load lastSyncDB
  let lastSyncDB = await loadLastSyncDB(
    this.vault.getName(),
    remoteBaseDir,
  )
  if (!lastSyncDB) {
    lastSyncDB = await SyncDB.empty(deviceId)
  }
```

- [ ] **Step 2: 在原地插入重排后的代码**

```typescript
// Step 1: Load lastSyncDB (for deviceId and incremental scan)
let lastSyncDB = await loadLastSyncDB(
  this.vault.getName(),
  remoteBaseDir,
)
let deviceId: string
if (lastSyncDB) {
  deviceId = lastSyncDB.deviceId || crypto.randomUUID()
} else {
  deviceId = crypto.randomUUID()
  lastSyncDB = await SyncDB.empty(deviceId)
}

// Step 2: Acquire lock
const lock = new SyncLock(webdav, remoteBaseDir, deviceId)
const locked = await lock.acquire()
if (!locked) {
  emitSyncError(new Error('无法获取同步锁，请稍后重试'))
  return
}

try {
  // Step 3: Download remote DB
  const dbStorage = new DBStorage(webdav, remoteBaseDir)
  let remoteDB = await dbStorage.download()
  if (!remoteDB) {
    remoteDB = await SyncDB.empty('remote')
  }

  // Step 4: Incremental local scan (uses lastSyncDB to skip unchanged files)
  const localDB = await SyncDB.fromVault(this.vault, {
    exclude: filterRules.exclusionRules,
    include: filterRules.inclusionRules,
  }, lastSyncDB)
```

- [ ] **Step 3: 编译验证**

```bash
bun run build
```

Expected: 构建成功，无类型错误。

- [ ] **Step 4: 运行全部测试**

```bash
bun run test
```

Expected: 全部测试通过。

- [ ] **Step 5: 提交**

```bash
git add src/sync/index.ts
git commit -m "feat: reorder sync steps and enable incremental local scan

Move lastSyncDB load, lock acquisition, and remoteDB download before
local scan. Pass lastSyncDB as baseDB to SyncDB.fromVault so unchanged
files (mtime match) skip SHA-256 computation.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```
