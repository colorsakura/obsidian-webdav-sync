import { getDirectoryContents } from '~/api/webdav'
import type { SyncRecordModel } from '~/model/sync-record.model'
import type { StatModel } from '~/model/stat.model'

/**
 * 用 sync record 的 remote 字段构建 remoteStats。
 * 哨兵匹配时替代 remoteFs.walk() 全量遍历。
 */
export function buildRemoteStatsFromRecords(
  records: Map<string, SyncRecordModel>,
): StatModel[] {
  const stats: StatModel[] = []
  for (const [, record] of records) {
    if (!record.remote.isDeleted) {
      stats.push(record.remote)
    }
  }
  return stats
}

/**
 * 用一次 PROPFIND Depth:1 获取 remoteBaseDir 的直接子项，
 * 将所有 "文件名|lastmod" 排序后拼接，生成确定性指纹。
 *
 * 返回值是 base-36 编码的哈希字符串（使用 djb2 算法）。
 */
export async function computeRemoteFingerprint(
  token: string,
  endpoint: string,
  remoteBaseDir: string,
): Promise<string> {
  const contents = await getDirectoryContents(token, remoteBaseDir, endpoint)
  const payload = contents
    .map((f) => `${f.filename}|${f.lastmod}`)
    .sort()
    .join('\n')
  return djb2(payload)
}

/** djb2 哈希算法 — 简单快速，适合短字符串指纹 */
function djb2(str: string): string {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i)
    hash |= 0
  }
  return hash.toString(36)
}
