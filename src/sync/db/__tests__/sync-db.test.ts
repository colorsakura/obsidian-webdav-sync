import { describe, it, expect, vi } from 'vitest'
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
      const filterRules = { exclude: [{ expr: '*.txt', options: { caseSensitive: false } }], include: [] }

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

    it('应该在传入无效数据时抛出错误', async () => {
      const corruptBuffer = new ArrayBuffer(100)
      const view = new Uint8Array(corruptBuffer)
      for (let i = 0; i < 100; i++) view[i] = Math.floor(Math.random() * 256)
      await expect(SyncDB.fromBuffer(corruptBuffer)).rejects.toThrow(
        'Failed to load SyncDB from buffer: invalid or corrupt SQLite data'
      )
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

  describe('deleteFile', () => {
    it('应该删除指定文件', async () => {
      const db = await SyncDB.empty('device-1')
      db.upsertFile({ path: 'test.md', mtime: 1000, size: 100, hash: 'a'.repeat(64), isDir: 0 })
      expect(db.getFile('test.md')).toBeDefined()

      db.deleteFile('test.md')
      expect(db.getFile('test.md')).toBeUndefined()
      expect(db.getAllPaths().has('test.md')).toBe(false)
    })
  })

  describe('upsertFile', () => {
    it('应该更新已有文件（REPLACE 语义）', async () => {
      const db = await SyncDB.empty('device-1')
      db.upsertFile({ path: 'test.md', mtime: 1000, size: 100, hash: 'a'.repeat(64), isDir: 0 })

      // 更新同一路径的文件
      db.upsertFile({ path: 'test.md', mtime: 2000, size: 200, hash: 'b'.repeat(64), isDir: 0 })

      const file = db.getFile('test.md')!
      expect(file.mtime).toBe(2000)
      expect(file.size).toBe(200)
      expect(file.hash).toBe('b'.repeat(64))
    })
  })
})

// helper: 构造模拟 Obsidian Vault，adapter.list 仅返回指定路径的直接子节点
function createMockVault(entries: Record<string, any>) {
  return {
    adapter: {
      list: vi.fn().mockImplementation((path: string) => {
        // 将请求路径标准化为无首尾斜杠
        const normalizedPath = path.replace(/^\/+/, '').replace(/\/+$/, '')

        const directFiles: string[] = []
        const directFolders: string[] = []

        for (const [entryPath, entry] of Object.entries(entries)) {
          const cleanPath = entryPath.replace(/\/+$/, '')
          const parts = cleanPath.split('/')

          let parentPath: string
          if (parts.length === 1) {
            parentPath = ''
          } else {
            parentPath = parts.slice(0, -1).join('/')
          }

          if (parentPath === normalizedPath) {
            if (entry.isDir) {
              directFolders.push(cleanPath) // 完整路径，无尾斜杠
            } else {
              directFiles.push(cleanPath) // 完整路径
            }
          }
        }

        return { files: directFiles, folders: directFolders }
      }),
      readBinary: vi.fn().mockImplementation((path: string) => {
        const f = entries[path]
        if (f?.isDir) throw new Error('Cannot read directory')
        return new TextEncoder().encode(f?.content ?? '').buffer
      }),
      stat: vi.fn().mockImplementation((path: string) => {
        // 支持目录以 'folder/' 或 'folder' 形式存储
        let f = entries[path]
        if (!f) f = entries[path + '/']
        return { mtime: f?.mtime ?? 0, size: f?.content?.length ?? 0, type: f?.isDir ? 'folder' : 'file' }
      }),
    },
  } as any
}

const mockFilterRules = { exclude: [], include: [] }
