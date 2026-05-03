import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncLock } from '../sync-lock';

function createMockWebdav(existingLock?: object) {
  const locks = new Map<string, string>();
  if (existingLock) {
    locks.set('/remote/_sync/lock', JSON.stringify(existingLock));
  }
  return {
    getFileContents: vi.fn().mockImplementation(async (path: string) => {
      const content = locks.get(path);
      if (content === undefined) {
        const err = new Error('Not Found') as any;
        err.status = 404;
        throw err;
      }
      return content;
    }),
    putFileContents: vi.fn().mockImplementation(async (path: string, content: string) => {
      locks.set(path, content);
      return true;
    }),
    deleteFile: vi.fn().mockImplementation(async (path: string) => {
      locks.delete(path);
    }),
  } as any;
}

describe('SyncLock', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1700000000000 });
  });

  describe('acquire', () => {
    it('应该在锁不存在时成功获取', async () => {
      const webdav = createMockWebdav();
      const lock = new SyncLock(webdav, '/remote', 'device-1', 300000);

      const result = await lock.acquire();
      expect(result).toBe(true);
      expect(lock.isHeld).toBe(true);
    });

    it('应该在锁已过期时抢占', async () => {
      const webdav = createMockWebdav({
        deviceId: 'old-device',
        acquiredAt: 1700000000000 - 400000, // 6.6 分钟前
        version: 1,
        token: 'old-token',
      });
      const lock = new SyncLock(webdav, '/remote', 'device-1', 300000);

      const result = await lock.acquire();
      expect(result).toBe(true);
    });

    it('应该在锁未过期时获取失败', async () => {
      // 切换到真实定时器，mock setTimeout 使其通过 queueMicrotask 立即触发，
      // 这样 30 轮 backoff 都在 microtask 中完成，不会导致 fake timers 兼容问题
      vi.useRealTimers();
      vi.spyOn(Date, 'now').mockReturnValue(1700000000000);

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        ((fn: () => void, _delay?: number) => {
          queueMicrotask(fn);
          return 0 as any;
        }) as typeof setTimeout,
      );

      const webdav = createMockWebdav({
        deviceId: 'other-device',
        acquiredAt: 1700000000000 - 60000, // 1 分钟前
        version: 1,
        token: 'other-token',
      });
      const lock = new SyncLock(webdav, '/remote', 'device-1', 300000);

      const result = await lock.acquire();
      expect(result).toBe(false);

      setTimeoutSpy.mockRestore();
      vi.useFakeTimers({ now: 1700000000000 });
    });

    it('应该通过回读 token 验证锁归属', async () => {
      let storedContent = '';
      const webdav = createMockWebdav();
      webdav.putFileContents.mockImplementation(async (path: string, content: string) => {
        storedContent = content;
      });
      webdav.getFileContents.mockImplementation(async (path: string) => {
        if (storedContent) {
          const parsed = JSON.parse(storedContent);
          return JSON.stringify({ ...parsed, token: 'evil-token' });
        }
        const err = new Error('Not Found') as any;
        err.status = 404;
        throw err;
      });

      const lock = new SyncLock(webdav, '/remote', 'device-1', 300000);
      const result = await lock.acquire();
      expect(result).toBe(false);
    });
  });

  describe('release', () => {
    it('应该释放持有的锁', async () => {
      const webdav = createMockWebdav();
      const lock = new SyncLock(webdav, '/remote', 'device-1', 300000);

      await lock.acquire();
      await lock.release();

      expect(lock.isHeld).toBe(false);
      expect(webdav.deleteFile).toHaveBeenCalledWith('/remote/_sync/lock');
    });

    it('未持锁时调用 release 应该是 noop', async () => {
      const webdav = createMockWebdav();
      const lock = new SyncLock(webdav, '/remote', 'device-1', 300000);

      await lock.release();
      // 不应该抛出异常
    });
  });
});
