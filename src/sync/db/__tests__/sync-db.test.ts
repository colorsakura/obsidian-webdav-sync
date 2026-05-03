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
      const filterRules = { exclude: ['*.txt'], include: [] }

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
