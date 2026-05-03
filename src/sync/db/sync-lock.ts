import type { WebDAVClient } from 'webdav';
import logger from '~/utils/logger';

/** 最大获取锁尝试次数，配合指数退避 (2^attempt ms) */
const MAX_ACQUIRE_ATTEMPTS = 30;

interface LockData {
  deviceId: string;
  acquiredAt: number;
  version: number;
  token: string;
}

export class SyncLock {
  private _held = false;
  private token: string | null = null;
  private lockPath: string;

  constructor(
    private webdav: WebDAVClient,
    private remoteBaseDir: string,
    private deviceId: string,
    private timeoutMs: number = 5 * 60 * 1000,
  ) {
    this.lockPath = `${remoteBaseDir}/_sync/lock`;
  }

  get isHeld(): boolean {
    return this._held;
  }

  async acquire(): Promise<boolean> {
    const token = crypto.randomUUID();

    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
      try {
        const content = await this.webdav.getFileContents(this.lockPath, { format: 'text' });
        const lock: LockData = typeof content === 'string' ? JSON.parse(content) : content;

        const age = Date.now() - lock.acquiredAt;
        if (age < this.timeoutMs) {
          const waitMs = Math.min(1000 * Math.pow(2, attempt), this.timeoutMs - age);
          logger.debug(`SyncLock: 锁被 ${lock.deviceId} 持有，等待 ${waitMs}ms`);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }

        logger.debug(`SyncLock: 锁已过期 (${age}ms)，抢占中`);
      } catch (e: any) {
        if (e.status === 404) {
          // 锁不存在，可以获取
        } else {
          throw e;
        }
      }

      // 写入锁
      const lockData: LockData = {
        deviceId: this.deviceId,
        acquiredAt: Date.now(),
        version: 0,
        token,
      };

      await this.webdav.putFileContents(this.lockPath, JSON.stringify(lockData), {
        contentLength: false,
        overwrite: true,
      });

      // 回读验证
      try {
        const verifyContent = await this.webdav.getFileContents(this.lockPath, { format: 'text' });
        const verify: LockData = typeof verifyContent === 'string' ? JSON.parse(verifyContent) : verifyContent;
        if (verify.token === token) {
          this._held = true;
          this.token = token;
          return true;
        }
        logger.debug('SyncLock: token 验证失败，锁被其他设备抢占');
        return false;
      } catch {
        logger.debug('SyncLock: 回读验证失败');
        return false;
      }
    }

    return false;
  }

  async release(): Promise<void> {
    if (!this._held || !this.token) return;

    try {
      const content = await this.webdav.getFileContents(this.lockPath, { format: 'text' });
      const lock: LockData = typeof content === 'string' ? JSON.parse(content) : content;
      if (lock.token === this.token) {
        await this.webdav.deleteFile(this.lockPath);
        logger.debug('SyncLock: 锁已释放');
      }
    } catch (e: any) {
      if (e.status === 404) {
        // 锁已不存在，OK
      } else {
        logger.warn('SyncLock: 释放锁失败', e);
      }
    } finally {
      this._held = false;
      this.token = null;
    }
  }
}
