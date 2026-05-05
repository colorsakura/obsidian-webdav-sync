# Remove traverseWebDAVCache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `traverseWebDAVCache` IndexedDB caching mechanism from `ResumableWebDAVTraversal` and all related remote cache export/restore functionality.

**Architecture:** Simplify `ResumableWebDAVTraversal` to a stateless BFS traversal class (keeping only mutex and 503 retry). Delete all cache-related files (KV storage, cache service, cache modals, cache settings tab). Clean up i18n and barrel exports.

**Tech Stack:** TypeScript, bun

---

### Task 1: Simplify ResumableWebDAVTraversal

**Files:**
- Modify: `src/utils/traverse-webdav.ts`

- [ ] **Step 1: Rewrite traverse-webdav.ts — remove all persistence**

Replace the file content. Remove: `kvKey` property, `saveInterval` property, `loadState()`, `saveState()`, `clearCache()`, `isCacheValid()`, `getAllFromCache()`, the in-BFS `nodes[normalizedPath]` cache check. Keep: `mutex`, `executeWithRetry`, BFS structure.

```typescript
import { Mutex } from 'async-mutex'
import { getDirectoryContents } from '~/api/webdav'
import type { StatModel } from '~/model/stat.model'
import { fileStatToStatModel } from './file-stat-to-stat-model'
import { is503Error } from './is-503-error'
import logger from './logger'
import sleep from './sleep'
import { stdRemotePath } from './std-remote-path'
import type { MaybePromise } from './types'

const traversalLocks = new Map<string, Mutex>()

function getTraversalLock(key: string): Mutex {
	if (!traversalLocks.has(key)) {
		traversalLocks.set(key, new Mutex())
	}
	return traversalLocks.get(key)!
}

async function executeWithRetry<T>(func: () => MaybePromise<T>): Promise<T> {
	while (true) {
		try {
			return await func()
		} catch (err) {
			if (is503Error(err as any)) {
				await sleep(30_000)
			} else {
				throw err
			}
		}
	}
}

export class ResumableWebDAVTraversal {
	private token: string
	private remoteBaseDir: string
	private endpoint: string
	private lockKey: string

	private queue: string[] = []
	private nodes: Record<string, StatModel[]> = {}

	constructor(options: {
		token: string
		remoteBaseDir: string
		endpoint: string
	}) {
		this.token = options.token
		this.remoteBaseDir = options.remoteBaseDir
		this.endpoint = options.endpoint
		this.lockKey = `${this.token}:${stdRemotePath(this.remoteBaseDir)}`
	}

	get lock() {
		return getTraversalLock(this.lockKey)
	}

	async traverse(): Promise<StatModel[]> {
		return await this.lock.runExclusive(async () => {
			this.queue = [this.remoteBaseDir]
			this.nodes = {}

			await this.bfsTraverse()

			const results: StatModel[] = []
			for (const items of Object.values(this.nodes)) {
				results.push(...items)
			}
			return results
		})
	}

	private async bfsTraverse(): Promise<void> {
		while (this.queue.length > 0) {
			const currentPath = this.queue[0]
			const normalizedPath = stdRemotePath(currentPath)

			try {
				const contents = await executeWithRetry(() =>
					getDirectoryContents(this.token, currentPath, this.endpoint),
				)

				const resultItems = contents.map(fileStatToStatModel)

				for (const item of resultItems) {
					if (item.isDir) {
						this.queue.push(item.path)
					}
				}

				this.nodes[normalizedPath] = resultItems
				this.queue.shift()
			} catch (err) {
				logger.error(`Error processing ${currentPath}`, err)
				throw err
			}
		}
	}
}
```

- [ ] **Step 2: Build to verify compilation**

```bash
bun run build 2>&1 | head -40
```

Expected: TypeScript errors (other files still reference deleted APIs). Confirm errors are only about external consumers, not the file itself.

- [ ] **Step 3: Commit**

```bash
git add src/utils/traverse-webdav.ts
git commit -m "refactor: simplify ResumableWebDAVTraversal, remove persistence"
```

---

### Task 2: Update WebDAVRemoteFileSystem

**Files:**
- Modify: `src/fs/webdav-remote.ts`

- [ ] **Step 1: Remove clearTraversalCache() and update walk()**

Make two edits to `src/fs/webdav-remote.ts`:

**Edit 1:** Remove import lines — lines 7, 10 (traverseWebDAVKV, getTraversalWebDAVDBKey):

```typescript
// Remove these two lines:
import { traverseWebDAVKV } from '~/storage/kv'
import { getTraversalWebDAVDBKey } from '~/utils/get-db-key'
```

**Edit 2:** Remove `clearTraversalCache()` method (lines 45-51):

```typescript
// Remove this entire method:
async clearTraversalCache(): Promise<void> {
    const kvKey = await getTraversalWebDAVDBKey(
        this.options.token,
        this.options.remoteBaseDir,
    )
    await traverseWebDAVKV.unset(kvKey)
}
```

**Edit 3:** Simplify `walk()` — remove `kvKey` and `saveInterval` from traversal construction (lines 54-62 change to):

```typescript
async walk() {
    const traversal = new ResumableWebDAVTraversal({
        token: this.options.token,
        remoteBaseDir: this.options.remoteBaseDir,
        endpoint: this.options.endpoint,
    })
    // ... rest of walk() unchanged
```

- [ ] **Step 2: Build to verify**

```bash
bun run build 2>&1 | head -40
```

Expected: Errors should now be about CacheSettings/CacheClearModal etc., not about these two files.

- [ ] **Step 3: Commit**

```bash
git add src/fs/webdav-remote.ts
git commit -m "refactor: remove clearTraversalCache, simplify walk() traversal call"
```

---

### Task 3: Remove CacheSettings from settings/index.ts

**Files:**
- Modify: `src/settings/index.ts`

- [ ] **Step 1: Remove CacheSettings import and usage, remove remoteCacheDir field**

Three edits:

**Edit 1:** Remove line 10 import:
```
import CacheSettings from './cache'
```

**Edit 2:** Remove line 26 `remoteCacheDir` from `NutstoreSettings`:
```typescript
// Remove this line:
remoteCacheDir?: string
```

**Edit 3:** Remove lines 68, 94-99, 122 — cacheSettings property, constructor init, and display call:

In constructor, remove:
```typescript
this.cacheSettings = new CacheSettings(
    this.app,
    this.plugin,
    this,
    this.containerEl.createDiv(),
)
```

In `display()`, remove:
```typescript
await this.cacheSettings.display()
```

Also remove the `cacheSettings: CacheSettings` property declaration (line 68).

- [ ] **Step 2: Remove remoteCacheDir default from src/index.ts**

Read `src/index.ts` line ~107 and remove the `remoteCacheDir: ''` line from `DEFAULT_SETTINGS`.

- [ ] **Step 3: Build to verify**

```bash
bun run build 2>&1 | head -40
```

Expected: Errors should now be confined to the files we're about to delete.

- [ ] **Step 4: Commit**

```bash
git add src/settings/index.ts src/index.ts
git commit -m "refactor: remove CacheSettings tab and remoteCacheDir setting"
```

---

### Task 4: Clean up get-db-key.ts and storage/index.ts

**Files:**
- Modify: `src/utils/get-db-key.ts`
- Modify: `src/storage/index.ts`

- [ ] **Step 1: Remove getTraversalWebDAVDBKey from get-db-key.ts**

Remove the function and its sha256 import (if no longer used):

```typescript
// Remove import { sha256 } from 'hash-wasm'  — check if sha256 used elsewhere
// Remove getTraversalWebDAVDBKey function (lines 13-20)
```

Keep `getDBKey` and its imports.

- [ ] **Step 2: Remove kv export from storage/index.ts**

```typescript
// Remove this line:
export * from './kv'
```

- [ ] **Step 3: Build to verify**

```bash
bun run build 2>&1 | head -40
```

Expected: Should compile cleanly now (deleted files won't be imported by anything).

- [ ] **Step 4: Commit**

```bash
git add src/utils/get-db-key.ts src/storage/index.ts
git commit -m "refactor: remove getTraversalWebDAVDBKey, clean up storage barrel"
```

---

### Task 5: Delete unused cache files

**Files:**
- Delete: `src/storage/kv.ts`
- Delete: `src/services/cache.service.v1.ts`
- Delete: `src/components/CacheClearModal.ts`
- Delete: `src/components/CacheSaveModal.ts`
- Delete: `src/components/CacheRestoreModal.ts`
- Delete: `src/settings/cache.ts`

- [ ] **Step 1: Delete all 6 files**

```bash
rm src/storage/kv.ts
rm src/services/cache.service.v1.ts
rm src/components/CacheClearModal.ts
rm src/components/CacheSaveModal.ts
rm src/components/CacheRestoreModal.ts
rm src/settings/cache.ts
```

- [ ] **Step 2: Build to verify clean compilation**

```bash
bun run build 2>&1
```

Expected: Clean build, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/storage/kv.ts src/services/cache.service.v1.ts src/components/CacheClearModal.ts src/components/CacheSaveModal.ts src/components/CacheRestoreModal.ts src/settings/cache.ts
git commit -m "refactor: delete unused cache files"
```

---

### Task 6: Clean up i18n

**Files:**
- Modify: `src/i18n/locales/en.ts`
- Modify: `src/i18n/locales/zh.ts`

- [ ] **Step 1: Remove entire `cache` section from en.ts**

Remove lines 187-265 (the entire `cache: { ... }` block), including the trailing comma.

The section to remove starts at:
```typescript
		cache: {
			title: 'Cache management',
```
and ends at the matching closing `},` before `sync:`.

- [ ] **Step 2: Remove entire `cache` section from zh.ts**

Remove lines 183-260 (the entire `cache: { ... }` block), including the trailing comma.

The section to remove starts at:
```typescript
		cache: {
			title: '缓存管理',
```
and ends at the matching closing `},` before `sync:`.

- [ ] **Step 3: Build to verify**

```bash
bun run build 2>&1
```

Expected: Clean build. Also run `bun test` to ensure no i18n key resolution issues at runtime.

- [ ] **Step 4: Commit**

```bash
git add src/i18n/locales/en.ts src/i18n/locales/zh.ts
git commit -m "refactor: remove cache-related i18n keys"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run full test suite**

```bash
bun test
```

Expected: All tests pass.

- [ ] **Step 2: Run production build**

```bash
bun run build
```

Expected: Clean build, no errors, no warnings.

- [ ] **Step 3: Verify no remaining references**

```bash
grep -rn "traverseWebDAVCache\|traverseWebDAVKV\|TraverseWebDAVCache\|getTraversalWebDAVDBKey\|CacheServiceV1\|CacheClearModal\|CacheSaveModal\|CacheRestoreModal\|remoteCacheDir" --include="*.ts" src/
```

Expected: No output.

- [ ] **Step 4: Commit** (if any final fixups needed)

```bash
git commit -m "chore: final verification, clean up remaining traces"
```
