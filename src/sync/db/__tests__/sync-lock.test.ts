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
      // 注意: 这里不能使用 fake timers (vi.useFakeTimers)，原因是:
      // fake timers 推进时间时也会推进 Date.now()，导致锁的 age 逐渐增大，
      // 在 MAX_ACQUIRE_ATTEMPTS=30 轮指数退避过程中锁会过期，从而使测试
      // 错误地通过 (acquire 会抢占过期锁成功)。
      //
      // 因此使用 realTimers + mocked setTimeout (queueMicrotask 立即触发)
      // + mocked Date.now (固定时间，锁永不过期)，让所有退避轮次瞬间完成。
      // 若 bun vitest 未来支持在不推进 Date.now 的情况下仅触发定时器，
      // 可以改用 fake timers 简化此测试。
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
      // 不应该删除其他设备持有的锁文件
      expect(webdav.deleteFile).not.toHaveBeenCalled();
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

    it('当锁被其他设备抢占时不应该删除锁文件', async () => {
      const webdav = createMockWebdav();
      const lock = new SyncLock(webdav, '/remote', 'device-1', 300000);

      // 正常获取锁
      await lock.acquire();
      expect(lock.isHeld).toBe(true);

      // 模拟其他设备覆盖了锁（token 变化）
      await webdav.putFileContents('/remote/_sync/lock', JSON.stringify({
        deviceId: 'device-2',
        acquiredAt: Date.now(),
        version: 1,
        token: 'other-device-token',
      }));

      // release 应该检测到 token 不匹配，不删除锁文件
      await lock.release();

      expect(lock.isHeld).toBe(false);
      // acquire 不调用 deleteFile，release 因 token 不匹配也不应调用
      expect(webdav.deleteFile).not.toHaveBeenCalled();
    });
  });
});
