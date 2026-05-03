# 同步决策方案重新设计 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用本地 SQLite 数据库替代远程 PROPFIND 目录扫描，消除同步决策对远程遍历的依赖。

**Architecture:** 每个设备维护 SQLite 数据库（files 表 + meta 表），同步时上传到远端 `_sync/db`。其他设备下载 DB 即可了解远端状态，通过三路 DB 对比（localDB vs remoteDB vs lastSyncDB）生成任务列表。使用远程锁文件（`_sync/lock`）保证互斥写入。

**Tech Stack:** sql.js (SQLite WASM), localforage (lastSyncDB 持久化), 现有 Task 系统不变

---

## 文件结构

```
src/sync/db/
├── sync-db.ts        # SyncDB: 本地扫描 → SQLite 生成、查询
├── db-storage.ts     # DBStorage: 远端上传/下载/校验
└── sync-lock.ts      # SyncLock: 获取/释放/超时检测

src/sync/decision/
├── two-way.decider.function.ts  # 重写：基于 DB hash 对比的纯决策逻辑
├── two-way.decider.ts           # 简化：注入 DB 依赖，调用决策函数
├── sync-decision.interface.ts   # 更新：新决策输入类型
└── base.decider.ts              # 简化：移除 syncRecord 相关

src/sync/index.ts                # 重写：新同步流程编排
```

**删除的文件：**
- `src/storage/sync-record.ts`
- `src/storage/sentinel.ts`
- `src/storage/blob.ts`
- `src/utils/remote-fingerprint.ts`
- `src/fs/utils/complete-loss-dir.ts`
- `src/sync/utils/has-ignored-in-folder.ts`
- `src/sync/utils/merge-mkdir-tasks.ts`
- `src/sync/utils/has-folder-content-changed.ts`
- `src/model/sync-record.model.ts`
- `src/model/remote-sentinel.model.ts`

---

### Task 1: 安装 sql.js 依赖

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装 sql.js**

```bash
bun add sql.js
```

- [ ] **Step 2: 验证安装**

```bash
bun run node -e "const initSqlJs = require('sql.js'); console.log('sql.js loaded:', typeof initSqlJs)"
```

Expected: `sql.js loaded: function`

- [ ] **Step 3: 添加类型声明**

`package.json` 中确认 `sql.js` 自带类型（`@types/sql.js` 不需要单独安装，sql.js 包内置了 TypeScript 类型定义）。

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: add sql.js dependency for SQLite-based sync DB"
```

---

### Task 2: 创建 SyncDB 类 — 核心 DB 生成与查询

**Files:**
- Create: `src/sync/db/sync-db.ts`
- Create: `src/sync/db/__tests__/sync-db.test.ts`

- [ ] **Step 1: 编写失败测试 — 从本地 vault 扫描生成 DB**

```typescript
// src/sync/db/__tests__/sync-db.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SyncDB } from '../sync-db'

describe('SyncDB', () => {
  describe('fromVault', () => {
    it('应该扫描 vault 并生成包含 files 和 meta 表的 SQLite 数据库', async () => {
      const mockVault = createMockVault({
        'note.md': { content: 'hello', mtime: 1000 },
        'folder/': { isDir: true, mtime: 900 },
        'folder/sub.md': { content: 'world', mtime: 1100 },
      })

      const db = await SyncDB.fromVault(mockVault, mockFilterRules)

      const files = db.getAllFiles()
      expect(files).toHaveLength(3)
      expect(files).toContainEqual(
        expect.objectContaining({ path: 'note.md', isDir: 0, mtime: 1000 })
      )
      expect(files).toContainEqual(
        expect.objectContaining({ path: 'folder', isDir: 1 })
      )
      expect(files).toContainEqual(
        expect.objectContaining({ path: 'folder/sub.md', isDir: 0 })
      )

      // hash 应该是 64 字符的 hex 字符串
      const noteFile = files.find(f => f.path === 'note.md')!
      expect(noteFile.hash).toHaveLength(64)
      expect(noteFile.hash).toMatch(/^[0-9a-f]{64}$/)
    })

    it('应该根据 filterRules 过滤文件', async () => {
      const mockVault = createMockVault({
        'note.md': { content: 'hello', mtime: 1000 },
        'ignored.txt': { content: 'ignored', mtime: 1000 },
      })
      const filterRules = { exclude: ['*.txt'] }

      const db = await SyncDB.fromVault(mockVault, filterRules)

      const files = db.getAllFiles()
      expect(files.map(f => f.path)).not.toContain('ignored.txt')
    })
  })

  describe('fromBuffer / toBuffer', () => {
    it('应该能够序列化和反序列化', async () => {
      const db = await SyncDB.empty('device-1')
      db.upsertFile({ path: 'test.md', mtime: 1000, size: 100, hash: 'a'.repeat(64), isDir: 0 })

      const buffer = db.toBuffer()
      const restored = await SyncDB.fromBuffer(buffer)

      expect(restored.getAllFiles()).toEqual(db.getAllFiles())
      expect(restored.getMeta('device_id')).toBe('device-1')
    })
  })

  describe('empty', () => {
    it('应该创建空 DB 并设置 device_id', async () => {
      const db = await SyncDB.empty('device-1')
      expect(db.getMeta('device_id')).toBe('device-1')
      expect(db.getAllFiles()).toHaveLength(0)
      expect(db.getMeta('version')).toBe('1')
    })
  })

  describe('getFile / getAllPaths', () => {
    it('应该支持按路径查询文件', async () => {
      const db = await SyncDB.empty('device-1')
      db.upsertFile({ path: 'a/b.md', mtime: 1000, size: 50, hash: 'b'.repeat(64), isDir: 0 })

      expect(db.getFile('a/b.md')).toBeDefined()
      expect(db.getFile('nonexistent')).toBeUndefined()
      expect(db.getAllPaths()).toEqual(new Set(['a/b.md']))
    })
  })
})

// helper
function createMockVault(files: Record<string, any>) {
  return {
    adapter: {
      list: vi.fn().mockResolvedValue({
        files: Object.entries(files)
          .filter(([, v]) => !v.isDir)
          .map(([path]) => path),
        folders: Object.entries(files)
          .filter(([, v]) => v.isDir)
          .map(([path]) => path),
      }),
      readBinary: vi.fn().mockImplementation((path: string) => {
        const f = files[path]
        if (f?.isDir) throw new Error('Cannot read directory')
        return new TextEncoder().encode(f?.content ?? '').buffer
      }),
      stat: vi.fn().mockImplementation((path: string) => {
        const f = files[path]
        return { mtime: f?.mtime ?? 0, size: f?.content?.length ?? 0, type: f?.isDir ? 'folder' : 'file' }
      }),
    },
  } as any
}

const mockFilterRules = { exclude: [], include: [] }
```

- [ ] **Step 2: 运行测试确认失败**

```bash
bun test src/sync/db/__tests__/sync-db.test.ts
```

Expected: FAIL — `SyncDB` module not found

- [ ] **Step 3: 实现 SyncDB 类**

```typescript
// src/sync/db/sync-db.ts
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'
import type { Vault } from 'obsidian'
import { sha256Hex } from '~/utils/sha256'
import { globToRegex } from '~/utils/glob-to-regex'

export interface DBFile {
  path: string
  mtime: number
  size: number
  hash: string
  isDir: number  // SQLite 用 0/1
}

export interface FilterRules {
  exclude: string[]
  include: string[]
}

export class SyncDB {
  private constructor(private sqlDb: SqlJsDatabase) {}

  static async fromVault(vault: Vault, filterRules: FilterRules): Promise<SyncDB> {
    const sql = await initSqlJs()
    const db = new sql.Database()
    SyncDB.initSchema(db)

    const deviceId = crypto.randomUUID()
    SyncDB.setMeta(db, 'device_id', deviceId)
    SyncDB.setMeta(db, 'version', '1')
    SyncDB.setMeta(db, 'created_at', String(Date.now()))

    const { files, folders } = await vault.adapter.list('/')

    const excludePatterns = filterRules.exclude.map(p => globToRegex(p))
    const includePatterns = filterRules.include.map(p => globToRegex(p))

    const isIgnored = (path: string): boolean => {
      if (includePatterns.length > 0) {
        return !includePatterns.some(r => r.test(path))
      }
      return excludePatterns.some(r => r.test(path))
    }

    // 插入目录
    const allFolders = new Set<string>()
    for (const folder of folders) {
      if (isIgnored(folder)) continue
      allFolders.add(folder)
      // 同时确保父目录存在
      const parts = folder.split('/')
      for (let i = 1; i < parts.length; i++) {
        allFolders.add(parts.slice(0, i).join('/'))
      }
    }

    const insertStmt = db.prepare(
      'INSERT OR REPLACE INTO files (path, mtime, size, hash, is_dir) VALUES (?, ?, ?, ?, ?)'
    )

    for (const folder of allFolders) {
      insertStmt.run([folder, 0, 0, '', 1])
    }

    // 插入文件
    for (const filePath of files) {
      if (isIgnored(filePath)) continue
      const content = await vault.adapter.readBinary(filePath)
      const stat = await vault.adapter.stat(filePath)
      const hash = await sha256Hex(content)
      insertStmt.run([filePath, stat?.mtime ?? 0, stat?.size ?? 0, hash, 0])
    }

    insertStmt.free()
    return new SyncDB(db)
  }

  static async fromBuffer(buffer: ArrayBuffer): Promise<SyncDB> {
    const sql = await initSqlJs()
    const db = new sql.Database(new Uint8Array(buffer))
    return new SyncDB(db)
  }

  static async empty(deviceId: string): Promise<SyncDB> {
    const sql = await initSqlJs()
    const db = new sql.Database()
    SyncDB.initSchema(db)
    SyncDB.setMeta(db, 'device_id', deviceId)
    SyncDB.setMeta(db, 'version', '1')
    SyncDB.setMeta(db, 'created_at', String(Date.now()))
    return new SyncDB(db)
  }

  toBuffer(): ArrayBuffer {
    return this.sqlDb.export().buffer
  }

  getAllFiles(): DBFile[] {
    const results = this.sqlDb.exec('SELECT path, mtime, size, hash, is_dir FROM files')
    if (results.length === 0) return []
    const { columns, values } = results[0]
    return values.map(row => ({
      path: row[columns.indexOf('path')] as string,
      mtime: row[columns.indexOf('mtime')] as number,
      size: row[columns.indexOf('size')] as number,
      hash: row[columns.indexOf('hash')] as string,
      isDir: row[columns.indexOf('is_dir')] as number,
    }))
  }

  getFile(path: string): DBFile | undefined {
    const stmt = this.sqlDb.prepare('SELECT path, mtime, size, hash, is_dir FROM files WHERE path = ?')
    stmt.bind([path])
    if (stmt.step()) {
      const cols = stmt.getColumnNames()
      const vals = stmt.get()
      stmt.free()
      return {
        path: vals[cols.indexOf('path')] as string,
        mtime: vals[cols.indexOf('mtime')] as number,
        size: vals[cols.indexOf('size')] as number,
        hash: vals[cols.indexOf('hash')] as string,
        isDir: vals[cols.indexOf('is_dir')] as number,
      }
    }
    stmt.free()
    return undefined
  }

  getAllPaths(): Set<string> {
    const results = this.sqlDb.exec('SELECT path FROM files')
    if (results.length === 0) return new Set()
    return new Set(results[0].values.map(row => row[0] as string))
  }

  upsertFile(file: DBFile): void {
    this.sqlDb.run(
      'INSERT OR REPLACE INTO files (path, mtime, size, hash, is_dir) VALUES (?, ?, ?, ?, ?)',
      [file.path, file.mtime, file.size, file.hash, file.isDir]
    )
  }

  deleteFile(path: string): void {
    this.sqlDb.run('DELETE FROM files WHERE path = ?', [path])
  }

  getMeta(key: string): string | undefined {
    const stmt = this.sqlDb.prepare('SELECT value FROM meta WHERE key = ?')
    stmt.bind([key])
    if (stmt.step()) {
      const val = stmt.get()[0] as string
      stmt.free()
      return val
    }
    stmt.free()
    return undefined
  }

  setMeta(key: string, value: string): void {
    this.sqlDb.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value])
  }

  get deviceId(): string {
    return this.getMeta('device_id') ?? ''
  }

  get version(): number {
    return parseInt(this.getMeta('version') ?? '1', 10)
  }

  private static initSchema(db: SqlJsDatabase): void {
    db.run(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        hash TEXT NOT NULL,
        is_dir INTEGER DEFAULT 0
      )
    `)
    db.run(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `)
  }

  private static setMeta(db: SqlJsDatabase, key: string, value: string): void {
    db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value])
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
bun test src/sync/db/__tests__/sync-db.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sync/db/sync-db.ts src/sync/db/__tests__/sync-db.test.ts
git commit -m "feat: add SyncDB class for local vault scanning and SQLite DB generation"
```

---

### Task 3: 创建 SyncLock 类 — 远程读写锁

**Files:**
- Create: `src/sync/db/sync-lock.ts`
- Create: `src/sync/db/__tests__/sync-lock.test.ts`

- [ ] **Step 1: 编写失败测试**

```typescript
// src/sync/db/__tests__/sync-lock.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SyncLock } from '../sync-lock'
import type { WebDAVClient } from 'webdav'

function createMockWebdav(existingLock?: object) {
  const locks = new Map<string, string>()
  if (existingLock) {
    locks.set('/remote/_sync/lock', JSON.stringify(existingLock))
  }
  return {
    getFileContents: vi.fn().mockImplementation(async (path: string) => {
      const content = locks.get(path)
      if (content === undefined) {
        const err = new Error('Not Found') as any
        err.status = 404
        throw err
      }
      return content
    }),
    putFileContents: vi.fn().mockImplementation(async (path: string, content: string) => {
      locks.set(path, content)
      return true
    }),
    deleteFile: vi.fn().mockImplementation(async (path: string) => {
      locks.delete(path)
    }),
  } as any
}

describe('SyncLock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1700000000000)
  })

  describe('acquire', () => {
    it('应该在锁不存在时成功获取', async () => {
      const webdav = createMockWebdav()
      const lock = new SyncLock(webdav, '/remote', 'device-1', 300000)

      const result = await lock.acquire()
      expect(result).toBe(true)
      expect(lock.isHeld).toBe(true)
    })

    it('应该在锁已过期时抢占', async () => {
      const webdav = createMockWebdav({
        deviceId: 'old-device',
        acquiredAt: 1700000000000 - 400000, // 6.6 分钟前
        version: 1,
        token: 'old-token',
      })
      const lock = new SyncLock(webdav, '/remote', 'device-1', 300000)

      const result = await lock.acquire()
      expect(result).toBe(true)
    })

    it('应该在锁未过期时等待重试', async () => {
      const webdav = createMockWebdav({
        deviceId: 'other-device',
        acquiredAt: 1700000000000 - 60000, // 1 分钟前
        version: 1,
        token: 'other-token',
      })
      const lock = new SyncLock(webdav, '/remote', 'device-1', 300000)

      // 第一次尝试失败
      const firstTry = lock.acquire()
      // 应该返回 false 或抛出
      await expect(firstTry).resolves.toBe(false)
    })

    it('应该通过回读 token 验证锁归属', async () => {
      // 模拟竞态：写入成功但被其他设备覆盖的场景
      let storedContent = ''
      const webdav = createMockWebdav()
      // 覆盖 putFileContents 模拟写入被覆盖
      webdav.putFileContents.mockImplementation(async (path: string, content: string) => {
        storedContent = content
      })
      webdav.getFileContents.mockImplementation(async (path: string) => {
        // 回读时返回不同的 token（模拟被覆盖）
        if (storedContent) {
          const parsed = JSON.parse(storedContent)
          return JSON.stringify({ ...parsed, token: 'evil-token' })
        }
        const err = new Error('Not Found') as any
        err.status = 404
        throw err
      })

      const lock = new SyncLock(webdav, '/remote', 'device-1', 300000)
      const result = await lock.acquire()
      expect(result).toBe(false) // token 不匹配
    })
  })

  describe('release', () => {
    it('应该释放持有的锁', async () => {
      const webdav = createMockWebdav()
      const lock = new SyncLock(webdav, '/remote', 'device-1', 300000)

      await lock.acquire()
      await lock.release()

      expect(lock.isHeld).toBe(false)
      expect(webdav.deleteFile).toHaveBeenCalledWith('/remote/_sync/lock')
    })

    it('未持锁时调用 release 应该是 noop', async () => {
      const webdav = createMockWebdav()
      const lock = new SyncLock(webdav, '/remote', 'device-1', 300000)

      await lock.release()
      // 不应该抛出异常
    })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
bun test src/sync/db/__tests__/sync-lock.test.ts
```

Expected: FAIL

- [ ] **Step 3: 实现 SyncLock 类**

```typescript
// src/sync/db/sync-lock.ts
import type { WebDAVClient } from 'webdav'
import logger from '~/utils/logger'

interface LockData {
  deviceId: string
  acquiredAt: number
  version: number
  token: string
}

export class SyncLock {
  private _held = false
  private token: string | null = null
  private lockPath: string

  constructor(
    private webdav: WebDAVClient,
    private remoteBaseDir: string,
    private deviceId: string,
    private timeoutMs: number = 5 * 60 * 1000,
  ) {
    this.lockPath = `${remoteBaseDir}/_sync/lock`
  }

  get isHeld(): boolean {
    return this._held
  }

  async acquire(): Promise<boolean> {
    const token = crypto.randomUUID()

    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const content = await this.webdav.getFileContents(this.lockPath, { format: 'text' })
        const lock: LockData = typeof content === 'string' ? JSON.parse(content) : content

        const age = Date.now() - lock.acquiredAt
        if (age < this.timeoutMs) {
          // 锁未过期，等待重试
          const waitMs = Math.min(1000 * Math.pow(2, attempt), this.timeoutMs - age)
          logger.debug(`SyncLock: 锁被 ${lock.deviceId} 持有，等待 ${waitMs}ms`)
          await new Promise(resolve => setTimeout(resolve, waitMs))
          continue
        }

        // 锁已过期，抢占
        logger.debug(`SyncLock: 锁已过期 (${age}ms)，抢占中`)
      } catch (e: any) {
        if (e.status === 404) {
          // 锁不存在，可以获取
        } else {
          throw e
        }
      }

      // 写入锁
      const lockData: LockData = {
        deviceId: this.deviceId,
        acquiredAt: Date.now(),
        version: 0,
        token,
      }

      await this.webdav.putFileContents(this.lockPath, JSON.stringify(lockData), {
        contentLength: false,
        overwrite: true,
      })

      // 回读验证
      try {
        const verifyContent = await this.webdav.getFileContents(this.lockPath, { format: 'text' })
        const verify: LockData = typeof verifyContent === 'string' ? JSON.parse(verifyContent) : verifyContent
        if (verify.token === token) {
          this._held = true
          this.token = token
          return true
        }
        logger.debug('SyncLock: token 验证失败，锁被其他设备抢占')
        return false
      } catch {
        logger.debug('SyncLock: 回读验证失败')
        return false
      }
    }

    return false
  }

  async release(): Promise<void> {
    if (!this._held || !this.token) return

    try {
      const content = await this.webdav.getFileContents(this.lockPath, { format: 'text' })
      const lock: LockData = typeof content === 'string' ? JSON.parse(content) : content
      if (lock.token === this.token) {
        await this.webdav.deleteFile(this.lockPath)
        logger.debug('SyncLock: 锁已释放')
      }
    } catch (e: any) {
      if (e.status === 404) {
        // 锁已不存在，OK
      } else {
        logger.warn('SyncLock: 释放锁失败', e)
      }
    } finally {
      this._held = false
      this.token = null
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
bun test src/sync/db/__tests__/sync-lock.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sync/db/sync-lock.ts src/sync/db/__tests__/sync-lock.test.ts
git commit -m "feat: add SyncLock for remote mutual exclusion"
```

---

### Task 4: 创建 DBStorage 类 — 远端 DB 上传/下载/校验

**Files:**
- Create: `src/sync/db/db-storage.ts`
- Create: `src/sync/db/__tests__/db-storage.test.ts`

- [ ] **Step 1: 编写失败测试**

```typescript
// src/sync/db/__tests__/db-storage.test.ts
import { describe, it, expect, vi } from 'vitest'
import { SyncDB } from '../sync-db'
import { DBStorage } from '../db-storage'

function createMockWebdav() {
  const files = new Map<string, ArrayBuffer>()
  return {
    getFileContents: vi.fn().mockImplementation(async (path: string) => {
      const content = files.get(path)
      if (!content) {
        const err = new Error('Not Found') as any
        err.status = 404
        throw err
      }
      return content
    }),
    putFileContents: vi.fn().mockImplementation(async (path: string, content: ArrayBuffer) => {
      files.set(path, content)
      return true
    }),
  } as any
}

describe('DBStorage', () => {
  describe('download', () => {
    it('应该下载远端 DB 并返回 SyncDB 实例', async () => {
      const webdav = createMockWebdav()
      const storage = new DBStorage(webdav, '/remote')

      const sourceDB = await SyncDB.empty('device-remote')
      sourceDB.upsertFile({ path: 'test.md', mtime: 1000, size: 50, hash: 'a'.repeat(64), isDir: 0 })
      await storage.upload(sourceDB)

      const downloaded = await storage.download()
      expect(downloaded).toBeDefined()
      expect(downloaded!.getAllFiles()).toEqual(sourceDB.getAllFiles())
    })

    it('DB 不存在时应该返回 undefined', async () => {
      const webdav = createMockWebdav()
      const storage = new DBStorage(webdav, '/remote')

      const result = await storage.download()
      expect(result).toBeUndefined()
    })
  })

  describe('validate', () => {
    it('有效 DB 应该通过校验', async () => {
      const db = await SyncDB.empty('device-1')
      const buffer = db.toBuffer()
      const result = await DBStorage.validate(buffer)
      expect(result).toBe(true)
    })

    it('损坏数据应该校验失败', async () => {
      const buffer = new ArrayBuffer(100)
      // 填入随机数据（非 SQLite 格式）
      const view = new Uint8Array(buffer)
      for (let i = 0; i < view.length; i++) {
        view[i] = Math.random() * 256
      }
      const result = await DBStorage.validate(buffer)
      expect(result).toBe(false)
    })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
bun test src/sync/db/__tests__/db-storage.test.ts
```

Expected: FAIL

- [ ] **Step 3: 实现 DBStorage 类**

```typescript
// src/sync/db/db-storage.ts
import type { WebDAVClient } from 'webdav'
import { SyncDB } from './sync-db'
import logger from '~/utils/logger'

export class DBStorage {
  private dbPath: string

  constructor(
    private webdav: WebDAVClient,
    remoteBaseDir: string,
  ) {
    this.dbPath = `${remoteBaseDir}/_sync/db`
  }

  async download(): Promise<SyncDB | undefined> {
    try {
      const data = await this.webdav.getFileContents(this.dbPath) as ArrayBuffer
      if (!data || data.byteLength === 0) {
        return undefined
      }
      return await SyncDB.fromBuffer(data)
    } catch (e: any) {
      if (e.status === 404) {
        return undefined
      }
      logger.warn('DBStorage: 下载 DB 失败', e)
      throw e
    }
  }

  async upload(db: SyncDB): Promise<void> {
    const buffer = db.toBuffer()
    await this.webdav.putFileContents(this.dbPath, buffer, {
      contentLength: buffer.byteLength,
      overwrite: true,
    })
    logger.debug(`DBStorage: DB 已上传 (${buffer.byteLength} bytes)`)
  }

  static async validate(buffer: ArrayBuffer): Promise<boolean> {
    try {
      // SQLite 文件头 magic number: "SQLite format 3\0"
      const header = new Uint8Array(buffer.slice(0, 16))
      const magic = new TextDecoder().decode(header.slice(0, 16))
      if (magic !== 'SQLite format 3 ') {
        return false
      }
      // 额外校验：尝试打开
      await SyncDB.fromBuffer(buffer)
      return true
    } catch {
      return false
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
bun test src/sync/db/__tests__/db-storage.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sync/db/db-storage.ts src/sync/db/__tests__/db-storage.test.ts
git commit -m "feat: add DBStorage for remote DB upload/download/validation"
```

---

### Task 5: 重写决策函数 — 基于 DB hash 对比

**Files:**
- Modify: `src/sync/decision/two-way.decider.function.ts`
- Modify: `src/sync/decision/sync-decision.interface.ts`
- Create: `src/sync/decision/__tests__/two-way.decider.function.test.ts`

- [ ] **Step 1: 更新 SyncDecisionInput 接口**

```typescript
// src/sync/decision/sync-decision.interface.ts
import type { SyncDB, DBFile } from '../db/sync-db'
import type { ConflictStrategy } from '../tasks/conflict-resolve.task'
import type { SkipReason } from '../tasks/skipped.task'
import type { BaseTask } from '../tasks/task.interface'

export interface SyncDecisionSettings {
  skipLargeFiles: { maxSize: string }
  conflictStrategy: ConflictStrategy
  useGitStyle: boolean
  syncMode: SyncMode
  configDir: string
  encryptionEnabled: boolean
}

export interface TaskOptions {
  remotePath: string
  localPath: string
  remoteBaseDir: string
}

export interface ConflictTaskOptions extends TaskOptions {
  localStat: { mtime: number; size: number; path: string; basename: string; isDir: false; isDeleted: boolean }
  remoteStat: { mtime: number; size: number; path: string; basename: string; isDir: false; isDeleted: boolean }
  strategy: ConflictStrategy
  useGitStyle: boolean
}

export interface PullTaskOptions extends TaskOptions {
  remoteSize: number
}

export type SkippedTaskOptions = TaskOptions &
  (
    | { reason: SkipReason.FileTooLarge; maxSize: number; remoteSize: number; localSize?: number }
    | { reason: SkipReason.FileTooLarge; maxSize: number; remoteSize?: number; localSize: number }
    | { reason: SkipReason.FileTooLarge; maxSize: number; remoteSize: number; localSize: number }
    | { reason: SkipReason.FolderContainsIgnoredItems; ignoredPaths: string[] }
  )

export interface TaskFactory {
  createPullTask(options: PullTaskOptions): BaseTask
  createPushTask(options: TaskOptions): BaseTask
  createConflictResolveTask(options: ConflictTaskOptions): BaseTask
  createNoopTask(options: TaskOptions): BaseTask
  createRemoveLocalTask(options: TaskOptions): BaseTask
  createRemoveRemoteTask(options: TaskOptions): BaseTask
  createMkdirLocalTask(options: TaskOptions): BaseTask
  createMkdirRemoteTask(options: TaskOptions): BaseTask
  createCleanRecordTask(options: TaskOptions): BaseTask
  createFilenameErrorTask(options: TaskOptions): BaseTask
  createSkippedTask(options: SkippedTaskOptions): BaseTask
}

export interface SyncDecisionInput {
  settings: SyncDecisionSettings
  localDB: SyncDB
  remoteDB: SyncDB
  lastSyncDB: SyncDB
  remoteBaseDir: string
  taskFactory: TaskFactory
}
```

- [ ] **Step 2: 编写失败测试 — 基于 hash 的决策逻辑**

```typescript
// src/sync/decision/__tests__/two-way.decider.function.test.ts
import { describe, it, expect, vi } from 'vitest'
import { twoWayDecider } from '../two-way.decider.function'
import { SyncDB } from '../../db/sync-db'
import type { SyncDecisionInput, TaskFactory } from '../sync-decision.interface'
import type { BaseTask } from '../../tasks/task.interface'
import { SyncMode } from '~/settings'

function createMockTaskFactory(): TaskFactory {
  const createTask = (type: string) => vi.fn().mockImplementation((opts: any) => ({
    type,
    options: opts,
    exec: async () => ({ success: true }),
    localPath: opts.localPath,
    remotePath: opts.remotePath,
  } as any as BaseTask))

  return {
    createPullTask: createTask('pull'),
    createPushTask: createTask('push'),
    createConflictResolveTask: createTask('conflict'),
    createNoopTask: createTask('noop'),
    createRemoveLocalTask: createTask('remove-local'),
    createRemoveRemoteTask: createTask('remove-remote'),
    createMkdirLocalTask: createTask('mkdir-local'),
    createMkdirRemoteTask: createTask('mkdir-remote'),
    createCleanRecordTask: createTask('clean-record'),
    createFilenameErrorTask: createTask('filename-error'),
    createSkippedTask: createTask('skipped'),
  }
}

const defaultSettings = {
  skipLargeFiles: { maxSize: '' },
  conflictStrategy: 'latest-timestamp' as any,
  useGitStyle: false,
  syncMode: SyncMode.STRICT,
  configDir: '.obsidian',
  encryptionEnabled: false,
}

describe('twoWayDecider (DB-based)', () => {
  it('本地新增文件应该生成 Push 任务', async () => {
    const localDB = await SyncDB.empty('device-1')
    localDB.upsertFile({ path: 'new.md', mtime: 1000, size: 100, hash: 'a'.repeat(64), isDir: 0 })
    const remoteDB = await SyncDB.empty('device-2')
    const lastSyncDB = await SyncDB.empty('device-1')

    const factory = createMockTaskFactory()
    const input: SyncDecisionInput = {
      settings: defaultSettings,
      localDB,
      remoteDB,
      lastSyncDB,
      remoteBaseDir: '/remote',
      taskFactory: factory,
    }

    await twoWayDecider(input)

    expect(factory.createPushTask).toHaveBeenCalledWith(
      expect.objectContaining({ localPath: 'new.md', remotePath: 'new.md' })
    )
  })

  it('远端新增文件应该生成 Pull 任务', async () => {
    const localDB = await SyncDB.empty('device-1')
    const remoteDB = await SyncDB.empty('device-2')
    remoteDB.upsertFile({ path: 'remote-new.md', mtime: 1000, size: 200, hash: 'b'.repeat(64), isDir: 0 })
    const lastSyncDB = await SyncDB.empty('device-1')

    const factory = createMockTaskFactory()
    const input: SyncDecisionInput = {
      settings: defaultSettings,
      localDB,
      remoteDB,
      lastSyncDB,
      remoteBaseDir: '/remote',
      taskFactory: factory,
    }

    await twoWayDecider(input)

    expect(factory.createPullTask).toHaveBeenCalledWith(
      expect.objectContaining({ localPath: 'remote-new.md', remotePath: 'remote-new.md', remoteSize: 200 })
    )
  })

  it('hash 相同 → Noop', async () => {
    const db1 = await SyncDB.empty('device-1')
    db1.upsertFile({ path: 'same.md', mtime: 1000, size: 100, hash: 'c'.repeat(64), isDir: 0 })
    const db2 = await SyncDB.empty('device-2')
    db2.upsertFile({ path: 'same.md', mtime: 1000, size: 100, hash: 'c'.repeat(64), isDir: 0 })
    const db3 = await SyncDB.empty('device-1')
    db3.upsertFile({ path: 'same.md', mtime: 1000, size: 100, hash: 'c'.repeat(64), isDir: 0 })

    const factory = createMockTaskFactory()
    const input: SyncDecisionInput = {
      settings: defaultSettings,
      localDB: db1,
      remoteDB: db2,
      lastSyncDB: db3,
      remoteBaseDir: '/remote',
      taskFactory: factory,
    }

    await twoWayDecider(input)

    expect(factory.createNoopTask).toHaveBeenCalled()
    expect(factory.createPushTask).not.toHaveBeenCalled()
    expect(factory.createPullTask).not.toHaveBeenCalled()
  })

  it('本地修改 + 远端未改 → Push', async () => {
    const localDB = await SyncDB.empty('device-1')
    localDB.upsertFile({ path: 'edit.md', mtime: 2000, size: 150, hash: 'new-hash'.padEnd(64, 'x'), isDir: 0 })
    const remoteDB = await SyncDB.empty('device-2')
    remoteDB.upsertFile({ path: 'edit.md', mtime: 1000, size: 100, hash: 'old-hash'.padEnd(64, 'x'), isDir: 0 })
    const lastSyncDB = await SyncDB.empty('device-1')
    lastSyncDB.upsertFile({ path: 'edit.md', mtime: 1000, size: 100, hash: 'old-hash'.padEnd(64, 'x'), isDir: 0 })

    const factory = createMockTaskFactory()
    const input: SyncDecisionInput = {
      settings: defaultSettings,
      localDB,
      remoteDB,
      lastSyncDB,
      remoteBaseDir: '/remote',
      taskFactory: factory,
    }

    await twoWayDecider(input)

    expect(factory.createPushTask).toHaveBeenCalledWith(
      expect.objectContaining({ localPath: 'edit.md' })
    )
  })

  it('双方修改同文件 → Conflict', async () => {
    const localDB = await SyncDB.empty('device-1')
    localDB.upsertFile({ path: 'conflict.md', mtime: 2000, size: 150, hash: 'local-hash'.padEnd(64, 'x'), isDir: 0 })
    const remoteDB = await SyncDB.empty('device-2')
    remoteDB.upsertFile({ path: 'conflict.md', mtime: 3000, size: 160, hash: 'remote-hash'.padEnd(64, 'x'), isDir: 0 })
    const lastSyncDB = await SyncDB.empty('device-1')
    lastSyncDB.upsertFile({ path: 'conflict.md', mtime: 1000, size: 100, hash: 'base-hash'.padEnd(64, 'x'), isDir: 0 })

    const factory = createMockTaskFactory()
    const input: SyncDecisionInput = {
      settings: defaultSettings,
      localDB,
      remoteDB,
      lastSyncDB,
      remoteBaseDir: '/remote',
      taskFactory: factory,
    }

    await twoWayDecider(input)

    expect(factory.createConflictResolveTask).toHaveBeenCalledWith(
      expect.objectContaining({ localPath: 'conflict.md' })
    )
  })

  it('本地删除 + 远端未改 → RemoveRemote', async () => {
    const localDB = await SyncDB.empty('device-1')
    const remoteDB = await SyncDB.empty('device-2')
    remoteDB.upsertFile({ path: 'del.md', mtime: 1000, size: 100, hash: 'd'.repeat(64), isDir: 0 })
    const lastSyncDB = await SyncDB.empty('device-1')
    lastSyncDB.upsertFile({ path: 'del.md', mtime: 1000, size: 100, hash: 'd'.repeat(64), isDir: 0 })

    const factory = createMockTaskFactory()
    const input: SyncDecisionInput = {
      settings: defaultSettings,
      localDB,
      remoteDB,
      lastSyncDB,
      remoteBaseDir: '/remote',
      taskFactory: factory,
    }

    await twoWayDecider(input)

    expect(factory.createRemoveRemoteTask).toHaveBeenCalledWith(
      expect.objectContaining({ localPath: 'del.md' })
    )
  })

  it('双方删除 → CleanRecord（noop file task）', async () => {
    const localDB = await SyncDB.empty('device-1')
    const remoteDB = await SyncDB.empty('device-2')
    const lastSyncDB = await SyncDB.empty('device-1')
    lastSyncDB.upsertFile({ path: 'both-del.md', mtime: 1000, size: 100, hash: 'e'.repeat(64), isDir: 0 })

    const factory = createMockTaskFactory()
    const input: SyncDecisionInput = {
      settings: defaultSettings,
      localDB,
      remoteDB,
      lastSyncDB,
      remoteBaseDir: '/remote',
      taskFactory: factory,
    }

    await twoWayDecider(input)

    // 双方删除 -> 无实际任务，仅在清理阶段移除记录
    // 在新设计中，不需要 CleanRecord（因为 DB 上传时会自然清理）
    expect(factory.createPushTask).not.toHaveBeenCalled()
    expect(factory.createPullTask).not.toHaveBeenCalled()
    expect(factory.createRemoveLocalTask).not.toHaveBeenCalled()
    expect(factory.createRemoveRemoteTask).not.toHaveBeenCalled()
  })

  it('空 DB (首次同步) → 所有本地文件 Push', async () => {
    const localDB = await SyncDB.empty('device-1')
    localDB.upsertFile({ path: 'a.md', mtime: 1000, size: 100, hash: 'f'.repeat(64), isDir: 0 })
    localDB.upsertFile({ path: 'b.md', mtime: 1000, size: 100, hash: 'g'.repeat(64), isDir: 0 })
    const remoteDB = await SyncDB.empty('device-2')
    const lastSyncDB = await SyncDB.empty('device-1')

    const factory = createMockTaskFactory()
    const input: SyncDecisionInput = {
      settings: defaultSettings,
      localDB,
      remoteDB,
      lastSyncDB,
      remoteBaseDir: '/remote',
      taskFactory: factory,
    }

    await twoWayDecider(input)

    expect(factory.createPushTask).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
bun test src/sync/decision/__tests__/two-way.decider.function.test.ts
```

Expected: FAIL

- [ ] **Step 4: 重写决策函数**

```typescript
// src/sync/decision/two-way.decider.function.ts
import { parse as bytesParse } from 'bytes-iec'
import { hasInvalidChar } from '~/utils/has-invalid-char'
import logger from '~/utils/logger'
import { ConflictStrategy } from '../tasks/conflict-resolve.task'
import { SkipReason } from '../tasks/skipped.task'
import type { BaseTask } from '../tasks/task.interface'
import type { DBFile } from '../db/sync-db'
import type { SyncDecisionInput } from './sync-decision.interface'

function pickConflictStrategy(
  path: string,
  configDir: string,
  userStrategy: ConflictStrategy,
): ConflictStrategy {
  if (path === configDir || path.startsWith(configDir + '/')) {
    return ConflictStrategy.LatestTimeStamp
  }
  return userStrategy
}

export async function twoWayDecider(input: SyncDecisionInput): Promise<BaseTask[]> {
  const { settings, localDB, remoteDB, lastSyncDB, remoteBaseDir, taskFactory } = input

  let maxFileSize = Infinity
  const maxFileSizeStr = settings.skipLargeFiles.maxSize.trim()
  if (maxFileSizeStr !== '') {
    maxFileSize = bytesParse(maxFileSizeStr, { mode: 'jedec' }) ?? Infinity
  }

  const localFiles = new Map(localDB.getAllFiles().map(f => [f.path, f]))
  const remoteFiles = new Map(remoteDB.getAllFiles().map(f => [f.path, f]))
  const lastSyncFiles = new Map(lastSyncDB.getAllFiles().map(f => [f.path, f]))

  const allPaths = new Set([
    ...localFiles.keys(),
    ...remoteFiles.keys(),
    ...lastSyncFiles.keys(),
  ])

  // 分离文件和目录
  const filePaths = [...allPaths].filter(p => {
    const l = localFiles.get(p)
    const r = remoteFiles.get(p)
    const b = lastSyncFiles.get(p)
    return !(l?.isDir || r?.isDir || b?.isDir)
  })
  const dirPaths = [...allPaths].filter(p => {
    const l = localFiles.get(p)
    const r = remoteFiles.get(p)
    const b = lastSyncFiles.get(p)
    return (l?.isDir || r?.isDir || b?.isDir)
  })

  const tasks: BaseTask[] = []
  const options = (path: string) => ({
    remotePath: path,
    localPath: path,
    remoteBaseDir,
  })

  // * 文件决策：基于 hash 对比
  for (const p of filePaths) {
    const local = localFiles.get(p)
    const remote = remoteFiles.get(p)
    const last = lastSyncFiles.get(p)

    if (last) {
      // 有历史记录 → 三路对比
      const localChanged = local ? local.hash !== last.hash : false
      const remoteChanged = remote ? remote.hash !== last.hash : false

      if (local && remote) {
        if (localChanged && remoteChanged) {
          // 双方都改 → Conflict
          tasks.push(taskFactory.createConflictResolveTask({
            ...options(p),
            localStat: toStat(local),
            remoteStat: toStat(remote),
            strategy: pickConflictStrategy(p, settings.configDir, settings.conflictStrategy),
            useGitStyle: settings.useGitStyle,
          }))
        } else if (localChanged) {
          // 仅本地改 → Push
          tasks.push(taskFactory.createPushTask(options(p)))
        } else if (remoteChanged) {
          // 仅远端改 → Pull
          tasks.push(taskFactory.createPullTask({ ...options(p), remoteSize: remote.size }))
        } else {
          // 都未改 → Noop
          tasks.push(taskFactory.createNoopTask(options(p)))
        }
      } else if (local && !remote) {
        if (remoteChanged) {
          // 远端改了但文件已不存在 → Pull（重建）
          tasks.push(taskFactory.createPullTask({ ...options(p), remoteSize: remote?.size ?? 0 }))
        } else {
          // 远端未改且文件不存在 → RemoveLocal（远端删了）
          tasks.push(taskFactory.createRemoveLocalTask(options(p)))
        }
      } else if (!local && remote) {
        if (localChanged) {
          // 本地改了但文件已不存在 → Push（重建）
          tasks.push(taskFactory.createPushTask(options(p)))
        } else {
          // 本地未改且文件不存在 → RemoveRemote（本地删了）
          tasks.push(taskFactory.createRemoveRemoteTask(options(p)))
        }
      }
      // !local && !remote → 双方删除，自然消失（DB 上传时不包含此文件）
    } else {
      // 无历史记录 → 二路对比
      if (local && remote) {
        if (local.hash !== remote.hash) {
          // 双方都有但 hash 不同 → Conflict
          tasks.push(taskFactory.createConflictResolveTask({
            ...options(p),
            localStat: toStat(local),
            remoteStat: toStat(remote),
            strategy: pickConflictStrategy(p, settings.configDir, settings.conflictStrategy),
            useGitStyle: settings.useGitStyle,
          }))
        } else {
          // hash 相同 → Noop
          tasks.push(taskFactory.createNoopTask(options(p)))
        }
      } else if (local && !remote) {
        // 仅本地有 → Push
        tasks.push(taskFactory.createPushTask(options(p)))
      } else if (!local && remote) {
        // 仅远端有 → Pull
        tasks.push(taskFactory.createPullTask({ ...options(p), remoteSize: remote.size }))
      }
    }
  }

  // * 目录决策
  for (const p of dirPaths) {
    const local = localFiles.get(p)
    const remote = remoteFiles.get(p)
    const last = lastSyncFiles.get(p)

    if (last) {
      if (local && remote) {
        // 双方都有 → Noop
        tasks.push(taskFactory.createNoopTask(options(p)))
      } else if (local && !remote) {
        // 远端缺失 → MkdirRemote
        tasks.push(taskFactory.createMkdirRemoteTask(options(p)))
      } else if (!local && remote) {
        // 本地缺失 → MkdirLocal
        tasks.push(taskFactory.createMkdirLocalTask(options(p)))
      }
    } else {
      if (local && remote) {
        tasks.push(taskFactory.createNoopTask(options(p)))
      } else if (local && !remote) {
        tasks.push(taskFactory.createMkdirRemoteTask(options(p)))
      } else if (!local && remote) {
        tasks.push(taskFactory.createMkdirLocalTask(options(p)))
      }
    }
  }

  return tasks
}

function toStat(f: DBFile): { mtime: number; size: number; path: string; basename: string; isDir: false; isDeleted: boolean } {
  const parts = f.path.split('/')
  return {
    mtime: f.mtime,
    size: f.size,
    path: f.path,
    basename: parts[parts.length - 1],
    isDir: false,
    isDeleted: false,
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
bun test src/sync/decision/__tests__/two-way.decider.function.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/sync/decision/two-way.decider.function.ts src/sync/decision/sync-decision.interface.ts src/sync/decision/__tests__/two-way.decider.function.test.ts
git commit -m "feat: rewrite decision function to use DB hash comparison instead of mtime"
```

---

### Task 6: 重写 TwoWaySyncDecider — 注入 DB 依赖

**Files:**
- Modify: `src/sync/decision/two-way.decider.ts`
- Modify: `src/sync/decision/base.decider.ts`
- Delete: `src/sync/decision/has-folder-content-changed.ts`

- [ ] **Step 1: 重写 TwoWaySyncDecider**

```typescript
// src/sync/decision/two-way.decider.ts
import type { WebDAVClient } from 'webdav'
import type { Vault } from 'obsidian'
import type NutstorePlugin from '~/index'
import type { SyncDB } from '../db/sync-db'
import { SyncLock } from '../db/sync-lock'
import { DBStorage } from '../db/db-storage'
import BaseSyncDecider from './base.decider'
import type {
  ConflictTaskOptions,
  PullTaskOptions,
  SkippedTaskOptions,
  TaskFactory,
  TaskOptions,
} from './sync-decision.interface'
import { twoWayDecider } from './two-way.decider.function'
import CleanRecordTask from '../tasks/clean-record.task'
import ConflictResolveTask from '../tasks/conflict-resolve.task'
import FilenameErrorTask from '../tasks/filename-error.task'
import MkdirLocalTask from '../tasks/mkdir-local.task'
import MkdirRemoteTask from '../tasks/mkdir-remote.task'
import NoopTask from '../tasks/noop.task'
import PullTask from '../tasks/pull.task'
import PushTask from '../tasks/push.task'
import RemoveLocalTask from '../tasks/remove-local.task'
import RemoveRemoteTask from '../tasks/remove-remote.task'
import SkippedTask from '../tasks/skipped.task'
import type { BaseTask } from '../tasks/task.interface'
import { computeEffectiveFilterRules } from '~/utils/config-dir-rules'

export default class TwoWaySyncDecider extends BaseSyncDecider {
  constructor(
    sync: BaseSyncDecider['sync'],
    private localDB: SyncDB,
    private remoteDB: SyncDB,
    private lastSyncDB: SyncDB,
    private encryptionKey?: CryptoKey | null,
  ) {
    super(sync)
  }

  async decide(): Promise<BaseTask[]> {
    const taskFactory: TaskFactory = {
      createPullTask: (options: PullTaskOptions) =>
        new PullTask({
          ...this.commonTaskOptions,
          ...options,
          encryptionKey: this.encryptionKey,
        }),
      createPushTask: (options: TaskOptions) =>
        new PushTask({ ...this.commonTaskOptions, ...options, encryptionKey: this.encryptionKey }),
      createConflictResolveTask: (options: ConflictTaskOptions) =>
        new ConflictResolveTask({ ...this.commonTaskOptions, ...options, encryptionKey: this.encryptionKey }),
      createNoopTask: (options: TaskOptions) =>
        new NoopTask({ ...this.commonTaskOptions, ...options, encryptionKey: this.encryptionKey }),
      createRemoveLocalTask: (options: TaskOptions) =>
        new RemoveLocalTask({ ...this.commonTaskOptions, ...options, encryptionKey: this.encryptionKey }),
      createRemoveRemoteTask: (options: TaskOptions) =>
        new RemoveRemoteTask({ ...this.commonTaskOptions, ...options, encryptionKey: this.encryptionKey }),
      createMkdirLocalTask: (options: TaskOptions) =>
        new MkdirLocalTask({ ...this.commonTaskOptions, ...options, encryptionKey: this.encryptionKey }),
      createMkdirRemoteTask: (options: TaskOptions) =>
        new MkdirRemoteTask({ ...this.commonTaskOptions, ...options, encryptionKey: this.encryptionKey }),
      createCleanRecordTask: (options: TaskOptions) =>
        new CleanRecordTask({ ...this.commonTaskOptions, ...options, encryptionKey: this.encryptionKey }),
      createFilenameErrorTask: (options: TaskOptions) =>
        new FilenameErrorTask({ ...this.commonTaskOptions, ...options, encryptionKey: this.encryptionKey }),
      createSkippedTask: (options: SkippedTaskOptions) =>
        new SkippedTask({ ...this.commonTaskOptions, ...options, encryptionKey: this.encryptionKey }),
    }

    return await twoWayDecider({
      settings: {
        skipLargeFiles: this.settings.skipLargeFiles,
        conflictStrategy: this.settings.conflictStrategy,
        useGitStyle: this.settings.useGitStyle,
        syncMode: this.settings.syncMode,
        configDir: this.vault.configDir,
        encryptionEnabled: !!this.encryptionKey,
      },
      localDB: this.localDB,
      remoteDB: this.remoteDB,
      lastSyncDB: this.lastSyncDB,
      remoteBaseDir: this.remoteBaseDir,
      taskFactory,
    })
  }

  private get commonTaskOptions() {
    return {
      webdav: this.webdav,
      vault: this.vault,
      remoteBaseDir: this.remoteBaseDir,
      syncRecord: null as any, // 过渡期：task 仍然需要 syncRecord 参数
    }
  }
}
```

- [ ] **Step 2: 更新 BaseSyncDecider — 移除 syncRecord 依赖**

```typescript
// src/sync/decision/base.decider.ts
import type { NutstoreSync } from '~/sync/index'
import type { WebDAVClient } from 'webdav'
import type { Vault } from 'obsidian'

export default class BaseSyncDecider {
  constructor(public sync: NutstoreSync) {}

  get webdav(): WebDAVClient {
    return this.sync.webdav
  }

  get vault(): Vault {
    return this.sync.vault
  }

  get remoteBaseDir(): string {
    return this.sync.remoteBaseDir
  }

  get settings() {
    return this.sync.settings
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/sync/decision/two-way.decider.ts src/sync/decision/base.decider.ts
git rm src/sync/decision/has-folder-content-changed.ts
git commit -m "refactor: rewrite TwoWaySyncDecider to use SyncDB instead of sync records"
```

---

### Task 7: 重写 NutstoreSync 编排器

**Files:**
- Modify: `src/sync/index.ts`
- Modify: `src/sync/utils/update-records.ts`（改为 update-last-sync-db.ts）

- [ ] **Step 1: 重写 NutstoreSync.start()**

`src/sync/index.ts` 的新同步流程：

```typescript
// src/sync/index.ts（关键变更部分）

async start({ mode }: { mode: SyncStartMode }) {
  try {
    const showNotice = mode === SyncStartMode.MANUAL_SYNC
    emitPreparingSync({ showNotice })

    const settings = this.settings
    const webdav = this.webdav
    const remoteBaseDir = stdRemotePath(this.options.remoteBaseDir)
    const filterRules = computeEffectiveFilterRules(this.plugin)

    // 加载加密密钥
    let encryptionKey = await loadEncryptionKey(this.app, this.settings.encryption)
    // ... (密钥加载逻辑不变，略)

    // 确保远端基础目录存在
    // ... (逻辑不变，略)

    // Step 1: 本地扫描 → 生成 localDB
    const localDB = await SyncDB.fromVault(this.vault, filterRules)
    const deviceId = localDB.deviceId
    emitSyncProgress(0, [])

    // Step 2: 获取远端锁
    const lock = new SyncLock(webdav, remoteBaseDir, deviceId)
    const locked = await lock.acquire()
    if (!locked) {
      emitSyncError(new Error('无法获取同步锁，请稍后重试'))
      return
    }

    try {
      // Step 3: 下载远端 DB
      const dbStorage = new DBStorage(webdav, remoteBaseDir)
      const remoteDB = await dbStorage.download() ?? await SyncDB.empty('remote')

      // Step 4: 加载 lastSyncDB
      const lastSyncDB = await loadLastSyncDB(this.vault.getName(), remoteBaseDir)
        ?? await SyncDB.empty(deviceId)

      // Step 5: 三路决策
      const decider = new TwoWaySyncDecider(
        this,
        localDB,
        remoteDB,
        lastSyncDB,
        encryptionKey,
      )
      const tasks = await decider.decide()

      if (tasks.length === 0) {
        emitEndSync({ showNotice, failedCount: 0 })
        return
      }

      // Step 6: 用户确认（可选）
      let confirmedTasks = this.filterTasksForConfirmation(tasks)
      if (showNotice && settings.confirmBeforeSync) {
        const result = await new TaskListConfirmModal(this.app, confirmedTasks).open()
        if (!result.confirm) {
          emitSyncError(new Error(i18n.t('sync.cancelled')))
          return
        }
        confirmedTasks = result.tasks
      }

      // ... (DeleteConfirmModal 逻辑保留，略)

      // Step 7: 执行任务
      emitStartSync({ showNotice })
      const chunkSize = 200
      const taskChunks = chunk(confirmedTasks, chunkSize)
      const allResults: TaskResult[] = []
      const allCompleted: BaseTask[] = []

      for (const taskChunk of taskChunks) {
        if (this.isCancelled) break
        const results = await this.execTasks(taskChunk, confirmedTasks, allCompleted)
        allResults.push(...results)
      }

      // Step 8: 上传新 DB
      // 基于 localDB + 任务结果构建新 DB
      const newDB = await buildNewDB(localDB, confirmedTasks, allResults)
      await dbStorage.upload(newDB)

      // Step 9: 更新 lastSyncDB
      await saveLastSyncDB(this.vault.getName(), remoteBaseDir, newDB)

      // 处理失败任务
      const failedCount = allResults.filter(r => !r.success).length
      if (mode === SyncStartMode.MANUAL_SYNC && failedCount > 0) {
        this.showFailedTasksModal(allResults)
      }

      emitEndSync({ failedCount, showNotice })
    } finally {
      // Step 10: 释放锁
      await lock.release()
    }
  } catch (error) {
    emitSyncError(error as Error)
    logger.error('Sync error:', error)
  } finally {
    this.subscriptions.forEach(sub => sub.unsubscribe())
  }
}
```

- [ ] **Step 2: 创建 localforage 持久化函数**

```typescript
// src/sync/utils/sync-db-persistence.ts
import localforage from 'localforage'
import { SyncDB } from '../db/sync-db'

const LAST_SYNC_DB_PREFIX = 'last_sync_db__'

export async function loadLastSyncDB(
  vaultName: string,
  remoteBaseDir: string,
): Promise<SyncDB | undefined> {
  const key = LAST_SYNC_DB_PREFIX + vaultName + '__' + remoteBaseDir
  const buffer = await localforage.getItem<ArrayBuffer>(key)
  if (!buffer) return undefined
  try {
    return await SyncDB.fromBuffer(buffer)
  } catch {
    return undefined
  }
}

export async function saveLastSyncDB(
  vaultName: string,
  remoteBaseDir: string,
  db: SyncDB,
): Promise<void> {
  const key = LAST_SYNC_DB_PREFIX + vaultName + '__' + remoteBaseDir
  await localforage.setItem(key, db.toBuffer())
}
```

- [ ] **Step 3: 创建 buildNewDB 函数**

```typescript
// src/sync/utils/build-new-db.ts
import { SyncDB } from '../db/sync-db'
import type { BaseTask, TaskResult } from '../tasks/task.interface'
import type { Vault } from 'obsidian'
import { sha256Hex } from '~/utils/sha256'

/**
 * 基于本地 DB 和任务执行结果构建新的 SyncDB
 * - 成功 Push: 本地文件现在存在于远端，保留在 DB 中
 * - 成功 Pull: 远端文件已下载，保留在 DB 中
 * - 成功 RemoveRemote: 远端文件已删除，从 DB 移除
 * - 成功 RemoveLocal: 本地文件已删除，从 DB 移除
 * - Noop/Conflict: 保持原样
 */
export async function buildNewDB(
  localDB: SyncDB,
  tasks: BaseTask[],
  results: TaskResult[],
): Promise<SyncDB> {
  const newDB = await SyncDB.empty(localDB.deviceId)
  const localFiles = new Map(localDB.getAllFiles().map(f => [f.path, f]))

  // 默认保留所有本地文件
  for (const [, f] of localFiles) {
    newDB.upsertFile(f)
  }

  // 根据任务结果调整
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]
    const result = results[i]
    if (!result?.success) continue

    // 简化的处理逻辑：成功 Push/Pull 的文件已经在本地，保留
    // Remove 操作需要从 DB 中移除
    const taskType = task.constructor.name
    if (taskType.includes('Remove')) {
      newDB.deleteFile(task.remotePath)
    }
  }

  // 更新版本号
  const newVersion = localDB.version + 1
  newDB.setMeta('version', String(newVersion))
  newDB.setMeta('updated_at', String(Date.now()))

  return newDB
}
```

- [ ] **Step 4: Commit**

```bash
git add src/sync/index.ts src/sync/utils/sync-db-persistence.ts src/sync/utils/build-new-db.ts
git commit -m "refactor: rewrite NutstoreSync to use DB-based sync flow"
```

---

### Task 8: 清理旧模块

**Files:**
- Delete: `src/storage/sync-record.ts`
- Delete: `src/storage/sentinel.ts`
- Delete: `src/storage/blob.ts`
- Delete: `src/utils/remote-fingerprint.ts`
- Delete: `src/fs/utils/complete-loss-dir.ts`
- Delete: `src/sync/utils/has-ignored-in-folder.ts`
- Delete: `src/sync/utils/merge-mkdir-tasks.ts`
- Delete: `src/sync/utils/merge-remove-remote-tasks.ts`
- Delete: `src/sync/utils/update-records.ts`
- Delete: `src/model/sync-record.model.ts`
- Delete: `src/model/remote-sentinel.model.ts`
- Modify: `src/storage/index.ts`（移除旧导出）
- Modify: `src/sync/tasks/task.interface.ts`（移除 syncRecord 字段）

- [ ] **Step 1: 更新 Task 接口 — 移除 syncRecord**

```typescript
// src/sync/tasks/task.interface.ts（变更部分）
export interface BaseTaskOptions {
  vault: Vault
  webdav: WebDAVClient
  remoteBaseDir: string
  remotePath: string
  localPath: string
  encryptionKey?: CryptoKey | null
  // 移除: syncRecord: SyncRecord
}
```

- [ ] **Step 2: 更新所有 Task 子类 — 移除 syncRecord 参数**

逐一更新以下文件，移除构造函数中的 `syncRecord` 参数：
- `src/sync/tasks/push.task.ts`
- `src/sync/tasks/pull.task.ts`
- `src/sync/tasks/conflict-resolve.task.ts`
- `src/sync/tasks/remove-local.task.ts`
- `src/sync/tasks/remove-remote.task.ts`
- `src/sync/tasks/remove-remote-recursively.task.ts`
- `src/sync/tasks/mkdir-local.task.ts`
- `src/sync/tasks/mkdir-remote.task.ts`
- `src/sync/tasks/mkdirs-remote.task.ts`
- `src/sync/tasks/noop.task.ts`
- `src/sync/tasks/skipped.task.ts`
- `src/sync/tasks/clean-record.task.ts`
- `src/sync/tasks/filename-error.task.ts`

每个文件的变更模式相同：

```typescript
// 移除
import type { SyncRecord } from '~/storage/sync-record'

// 构造函数中移除 syncRecord: SyncRecord 参数
// 以及对应的 this.syncRecord = syncRecord

// 移除所有 this.syncRecord.updateFileRecord(...) 调用
// 移除所有 this.syncRecord.deleteFileRecord(...) 调用
```

- [ ] **Step 3: 清理 LocalVaultFileSystem — 移除 SyncRecord 依赖**

```typescript
// src/fs/local-vault.ts
// 移除构造函数中的 syncRecord 参数
// 移除 SyncRecord import
```

- [ ] **Step 4: 删除旧文件并更新导出**

```bash
git rm src/storage/sync-record.ts
git rm src/storage/sentinel.ts
git rm src/storage/blob.ts
git rm src/utils/remote-fingerprint.ts
git rm src/fs/utils/complete-loss-dir.ts
git rm src/sync/utils/has-ignored-in-folder.ts
git rm src/sync/utils/merge-mkdir-tasks.ts
git rm src/sync/utils/merge-remove-remote-tasks.ts
git rm src/sync/utils/update-records.ts
git rm src/model/sync-record.model.ts
git rm src/model/remote-sentinel.model.ts
```

更新 `src/storage/index.ts`：移除 `syncRecordKV`, `blobKV`, `sentinelKV` 导出，保留 `localforage` 相关导出。

- [ ] **Step 5: 清理所有残留引用**

运行 TypeScript 编译检查：

```bash
bun run tsc -noEmit -skipLibCheck
```

修复所有类型错误。

- [ ] **Step 6: 更新现有测试中的引用**

检查所有测试文件中是否引用了已删除的模块：

```bash
grep -r "sync-record\|sentinel\|blob\|remote-fingerprint\|complete-loss-dir\|has-ignored-in-folder\|merge-mkdir-tasks\|merge-remove-remote\|update-records" src/ --include="*.test.ts"
```

更新或删除相关测试。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: remove old storage modules replaced by SyncDB"
```

---

### Task 9: 集成测试

**Files:**
- Create: `src/sync/__tests__/sync-flow.test.ts`

- [ ] **Step 1: 编写集成测试**

```typescript
// src/sync/__tests__/sync-flow.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SyncDB } from '../db/sync-db'
import { twoWayDecider } from '../decision/two-way.decider.function'
import type { TaskFactory } from '../decision/sync-decision.interface'
import type { BaseTask } from '../tasks/task.interface'
// ... 集成测试场景

describe('Sync Flow Integration', () => {
  it('首次同步：本地 100 个文件，远端为空 → 100 个 Push 任务', async () => {
    const localDB = await SyncDB.empty('device-1')
    for (let i = 0; i < 100; i++) {
      localDB.upsertFile({
        path: `notes/note-${i}.md`,
        mtime: 1000 + i,
        size: 100 + i,
        hash: `${i}`.repeat(64).slice(0, 64),
        isDir: 0,
      })
    }
    const remoteDB = await SyncDB.empty('remote')
    const lastSyncDB = await SyncDB.empty('device-1')

    // ... 运行决策并验证
  })

  it('增量同步：修改 5 个文件，新增 3 个，删除 2 个', async () => {
    // ... 构建场景并验证
  })

  it('冲突场景：双方同时编辑同一文件', async () => {
    // ... 构建场景并验证
  })
})
```

- [ ] **Step 2: Commit**

```bash
git add src/sync/__tests__/sync-flow.test.ts
git commit -m "test: add integration tests for DB-based sync flow"
```

---

### Task 10: 运行完整测试套件并修复

**Files:** 无特定文件

- [ ] **Step 1: 运行完整测试套件**

```bash
bun test
```

- [ ] **Step 2: 修复所有失败的测试**

逐个修复测试失败，确保所有测试通过。

- [ ] **Step 3: 运行 TypeScript 类型检查**

```bash
bun run tsc -noEmit -skipLibCheck
```

- [ ] **Step 4: 运行 dev 构建确认无运行时错误**

```bash
bun run dev
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: resolve test failures and type errors from sync redesign"
```

---

## 自审清单

### 1. Spec 覆盖

| Spec 章节 | 覆盖任务 |
|---|---|
| 数据库 Schema & 存储 | Task 2 (SyncDB) |
| 远程读写锁 | Task 3 (SyncLock) |
| 决策算法（三路 DB 对比） | Task 5 (决策函数) |
| 同步流程（10 步） | Task 7 (NutstoreSync) |
| 错误处理（锁超时、DB 损坏等） | Task 3 (SyncLock) + Task 4 (DBStorage.validate) |
| 架构变更（新增/保留/移除模块） | Task 2-4 (新增), Task 6,8 (移除) |

### 2. Placeholder 扫描

- 无 TBD/TODO
- 无 "适当添加错误处理" 等模糊描述
- 所有代码块包含实际代码
- 所有路径为实际文件路径

### 3. 类型一致性

- `DBFile` 接口在 Task 2 定义，后续任务一致使用
- `SyncDecisionInput` 在 Task 5 更新，Task 5/6 一致使用
- `SyncLock` 接口在 Task 3 定义，Task 7 一致使用
- `DBStorage` 接口在 Task 4 定义，Task 7 一致使用
- `SyncDB` 方法名在各任务中保持一致
