# 同步进度面板渲染性能优化实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用增量追加 + 渲染上限 + rAF 节流替代当前的全量 DOM 重建，将 200 任务的 DOM 创建从 ~20,000 次降至 ~200 次。

**Architecture:** SyncProgressModal 用 `renderedCount` 追踪已渲染进度，每次只渲染新增条目并 append 到列表。超出 `MAX_VISIBLE_ITEMS` 上限时移除头部旧 DOM 节点。ProgressService 用 `requestAnimationFrame` 替代 lodash throttle。

**Tech Stack:** TypeScript, Obsidian API, RxJS

---

## 文件结构

- **Modify:** `src/services/progress.service.ts` — `throttle` → `rAF`
- **Modify:** `src/components/SyncProgressModal.ts` — 增量渲染 + 上限裁剪

---

### Task 1: ProgressService — rAF 替代 throttle

**Files:**
- Modify: `src/services/progress.service.ts`

- [ ] **Step 1: 替换 throttle 为 rAF**

将 `src/services/progress.service.ts` 中的 `throttle` 导入删除，`updateModal` 改为 rAF 实现：

```typescript
// 删除第 1 行: import { throttle } from 'lodash-es'

// 在 syncEnd 字段后添加:
private rafId: number | null = null

// 替换第 36-40 行的 updateModal:
updateModal = () => {
    if (this.rafId !== null) return
    this.rafId = requestAnimationFrame(() => {
        this.rafId = null
        this.progressModal?.update()
    })
}
```

- [ ] **Step 2: 验证类型检查**

```bash
bun run build
```

预期：构建通过，无类型错误。

- [ ] **Step 3: 提交**

```bash
git add src/services/progress.service.ts
git commit -m "perf: replace throttle with requestAnimationFrame in ProgressService"
```

---

### Task 2: SyncProgressModal — 增量渲染 + 渲染上限

**Files:**
- Modify: `src/components/SyncProgressModal.ts`

- [ ] **Step 1: 添加 onStartSync 订阅和字段**

在构造函数中添加 `onStartSync` 订阅和 `renderedCount` 字段。在第 31 行 `syncCancelled` 后添加：

```typescript
private renderedCount = 0
private static readonly MAX_VISIBLE_ITEMS = 100
```

在 constructor 的 `this.updateMtimeSubscription` 之后添加 `onStartSync` 订阅：

```typescript
this.startSyncSubscription = onStartSync().subscribe(() => {
    this.renderedCount = 0
    this.syncCancelled = false
    this.filesList?.empty()
})
```

添加导入（第 11 行附近，在 `emitCancelSync` 中加上 `onStartSync`）：

```typescript
import {
    emitCancelSync,
    onCancelSync,
    onStartSync,
    onSyncUpdateMtimeProgress,
} from '../events'
```

添加字段声明（在第 32 行 `cancelSubscription` 后）：

```typescript
private startSyncSubscription: Subscription
```

在 `onClose()` 中添加取消订阅（第 283 行 `this.cancelSubscription.unsubscribe()` 之后）：

```typescript
this.startSyncSubscription.unsubscribe()
```

- [ ] **Step 2: 重构 update() — 增量渲染列表部分**

将 `update()` 方法中第 109-162 行的文件列表渲染逻辑改为增量追加：

```typescript
// 替换第 109-162 行（this.filesList.empty() 到 forEach 结束）

// Only render new items incrementally
const newItems = progress.completed.slice(this.renderedCount)
newItems.forEach((file) => {
    const item = this.filesList.createDiv({
        cls: 'flex items-center p-1 rounded text-2.5 gap-2 hover:bg-[var(--background-secondary)]',
    })

    const icon = item.createSpan({ cls: 'text-[var(--text-muted)]' })

    if (file instanceof CleanRecordTask) {
        setIcon(icon, 'archive-x')
    } else if (file instanceof ConflictResolveTask) {
        setIcon(icon, 'git-merge')
    } else if (file instanceof FilenameErrorTask) {
        setIcon(icon, 'refresh-cw-off')
    } else if (
        file instanceof MkdirLocalTask ||
        file instanceof MkdirRemoteTask ||
        file instanceof MkdirsRemoteTask
    ) {
        setIcon(icon, 'folder-plus')
    } else if (file instanceof PullTask) {
        setIcon(icon, 'arrow-down-narrow-wide')
    } else if (file instanceof PushTask) {
        setIcon(icon, 'arrow-up-narrow-wide')
    } else if (
        file instanceof RemoveLocalTask ||
        file instanceof RemoveRemoteTask ||
        file instanceof RemoveRemoteRecursivelyTask
    ) {
        setIcon(icon, 'trash')
    } else if (file instanceof SkippedTask) {
        setIcon(icon, 'chevron-last')
    } else {
        setIcon(icon, 'arrow-left-right')
    }

    const typeLabel = item.createSpan({
        cls: 'flex-none w-17 md:w-24 text-[var(--text-normal)] font-500',
    })
    typeLabel.setText(getTaskName(file))

    const filePath = item.createSpan({
        cls: 'flex-1 break-all',
    })
    filePath.setText(
        i18n.t('sync.filePath', {
            path: file.localPath,
        }),
    )
})

this.renderedCount = progress.completed.length

// Cap visible DOM nodes
while (
    this.filesList.children.length > SyncProgressModal.MAX_VISIBLE_ITEMS
) {
    this.filesList.firstElementChild?.remove()
}
```

- [ ] **Step 3: 添加计数提示**

在 `update()` 方法中，在进度统计更新之后（第 86 行后），添加计数提示更新逻辑。需要首先在 `onOpen()` 中添加计数提示元素。

在 `onOpen()` 中，第 246 行 `filesHeader` 创建后，给 `filesHeader` 设置文本的逻辑改为一个变量引用：

```typescript
// 第 243-246 行替换为:
const filesHeader = filesSection.createDiv({
    cls: 'font-500 text-3.5 pb-1 border-b border-[var(--background-modifier-border)]',
})
```

保留 `filesHeader` 的引用。添加字段声明（在第 30 行 `filesList` 后）：

```typescript
private filesHeader!: HTMLDivElement
```

在 `onOpen()` 中第 252 行附近添加赋值：

```typescript
this.filesHeader = filesHeader
```

然后在 `update()` 方法中（Step 2 的 cap 逻辑之后）添加：

```typescript
// Update header with count when capped
const totalRendered = this.renderedCount
if (totalRendered > SyncProgressModal.MAX_VISIBLE_ITEMS) {
    this.filesHeader.setText(
        i18n.t('sync.completedFilesTitle') +
            ` (${i18n.t('sync.showingRecent', {
                shown: SyncProgressModal.MAX_VISIBLE_ITEMS,
                total: totalRendered,
            })})`,
    )
} else {
    this.filesHeader.setText(i18n.t('sync.completedFilesTitle'))
}
```

- [ ] **Step 4: 添加 i18n 字符串**

在 `src/i18n/locales/zh.ts` 的 sync 段（第 295 行附近）添加：

```typescript
showingRecent: '显示最近 {{shown}} / 共 {{total}} 条',
```

在 `src/i18n/locales/en.ts` 对应位置添加：

```typescript
showingRecent: 'showing recent {{shown}} / {{total}} total',
```

- [ ] **Step 5: 验证构建**

```bash
bun run build
```

预期：构建通过。

- [ ] **Step 6: 运行测试**

```bash
bun run test
```

预期：所有已有测试通过。

- [ ] **Step 7: 提交**

```bash
git add src/components/SyncProgressModal.ts src/i18n/locales/zh.ts src/i18n/locales/en.ts
git commit -m "perf: incremental render with cap for SyncProgressModal"
```

---

### 验证检查清单

- [ ] 构建通过 (`bun run build`)
- [ ] 所有已有测试通过 (`bun test`)
- [ ] 手动验证：同步时进度弹窗的列表正常追加，无闪烁
- [ ] 手动验证：任务数超过 100 时列表头部显示计数提示，DOM 节点不超过 100
- [ ] 手动验证：取消同步后按钮变为关闭，重新同步时列表正确重置
