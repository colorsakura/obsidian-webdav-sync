# 同步进度面板渲染性能优化设计

## 背景

SyncProgressModal 在每次 `update()` 时全量清空并重建已完成文件列表的 DOM，50-200 任务规模下产生大量冗余 DOM 操作（总计约 20,000 次创建），导致卡顿和闪烁。

## 方案

增量追加 + 渲染上限 + rAF 节流。

### 渲染策略

```
update() → 只创建 completed.slice(renderedCount) 的 DOM → append 到列表 → 超出上限移除头部旧条目
```

### SyncProgressModal 改动

- 新增 `renderedCount = 0`：追踪已渲染数量
- 新增 `MAX_VISIBLE_ITEMS = 100`：列表 DOM 节点上限
- `update()` 只渲染 `completed.slice(renderedCount)`，不再执行 `empty()`
- 超出上限时移除列表头部旧条目，更新 `renderedCount`
- 移除 `reverse()`：直接 append，最新完成的任务在列表底部
- 超出上限时列表头部显示计数提示
- `onStartSync` 时重置 `renderedCount = 0`

### ProgressService 改动

- `throttle(fn, 200)` → `requestAnimationFrame` 合并更新

### 不同步部分

- 事件定义不动
- 同步引擎不动
- 状态栏/Notice 不动
- 缓存进度区域逻辑不动

### 性能对比

| 指标 | 当前 | 优化后 |
|------|------|--------|
| 200 任务总 DOM 创建 | ~20,000 | ~200 |
| 单次 update 最大 DOM 操作 | 200 节点 | 1 节点 |
| 列表最大 DOM 节点数 | 200 | 100 |

### 边界处理

- 任务数 < 100：不触发裁剪，行为与全量显示一致
- 同步取消/完成后重新同步：`renderedCount` 重置
- rAF 自动合并同帧多次调用
