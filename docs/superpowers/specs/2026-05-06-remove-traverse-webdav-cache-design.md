# Remove traverseWebDAVCache Design

## 动机

简化架构：移除 `ResumableWebDAVTraversal` 的 IndexedDB 持久化缓存机制及其相关的远程导出/恢复功能。

## 设计

### 核心变更：`ResumableWebDAVTraversal` 简化

去掉所有持久化相关属性和方法（`kvKey`、`loadState`、`saveState`、`clearCache`、`isCacheValid`）。`traverse()` 直接初始化队列为 `[remoteBaseDir]`，BFS 遍历全部目录，返回结果。

保留：
- `mutex` 防并发遍历
- `executeWithRetry` 503 自动重试

移除构造函数 `kvKey`、`saveInterval` 参数。

### 文件系统层：`WebDAVRemoteFileSystem`

- `walk()` — 构造 traversal 时去掉 `kvKey` 和 `saveInterval` 参数
- `clearTraversalCache()` — 删除（无外部调用者）

### 删除的文件

| 文件 | 原因 |
|------|------|
| `src/storage/kv.ts` | 只含 `TraverseWebDAVCache` + `traverseWebDAVKV` |
| `src/services/cache.service.v1.ts` | 只做缓存远程导出/恢复 |
| `src/components/CacheClearModal.ts` | 唯一选项是清遍历缓存 |
| `src/components/CacheSaveModal.ts` | 导出缓存到远程 |
| `src/components/CacheRestoreModal.ts` | 从远程恢复缓存 |
| `src/settings/cache.ts` | 只含缓存相关设置 UI |

### 修改的文件

| 文件 | 改动 |
|------|------|
| `src/storage/index.ts` | 去掉 `export * from './kv'` |
| `src/utils/traverse-webdav.ts` | 去掉全部持久化逻辑，变为纯 BFS |
| `src/fs/webdav-remote.ts` | 去掉 `clearTraversalCache()`，`walk()` 不再传 `kvKey` |
| `src/settings/index.ts` | 去掉 CacheSettings 注册、`remoteCacheDir` 字段 |
| `src/utils/get-db-key.ts` | 去掉 `getTraversalWebDAVDBKey` |
| `src/i18n/locales/en.ts` + `zh.ts` | 去掉缓存相关 i18n key |

### 错误处理

`bfsTraverse()` 的 `catch` 块去掉 `await this.saveState()`，只保留日志和 rethrow。
