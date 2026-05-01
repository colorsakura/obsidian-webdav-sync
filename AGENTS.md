# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 规则

- 必须用中文回复和思考
- 优先使用 bun 功能

## 项目概述

Obsidian 插件，通过 WebDAV 协议实现笔记双向同步，专为坚果云优化。支持端到端 AES-256-GCM 加密、增量同步、智能冲突解决（字符级 diff-match-patch 合并或时间戳优先）。

## 构建与开发

```bash
bun run dev       # 开发模式 (watch) — 并行启动 plugin + webdav-explorer
bun run build     # 生产构建 (tsc 类型检查 → esbuild 打包 → swc 转 ES5)
bun run test      # 运行 vitest 测试套件
bun run version   # 版本号更新 (version-bump.mjs)
```

## 架构

```
src/index.ts                     # 入口: NutstorePlugin (Obsidian Plugin 子类)
├── src/sync/                    # 核心同步引擎
│   ├── index.ts                 # NutstoreSync — 编排完整同步周期
│   ├── decision/                # 决策层: 对比 local/remote/record 状态决定操作
│   │   ├── two-way.decider.function.ts  # 纯决策逻辑 (双向同步核心算法)
│   │   └── two-way.decider.ts           # Decider 类，注入依赖并调用决策函数
│   ├── tasks/                   # 任务模式: Push/Pull/Mkdir/Remove/ConflictResolve 等
│   │   └── task.interface.ts    # BaseTask 抽象基类, TaskResult, TaskError
│   ├── core/merge-utils.ts      # diff-match-patch 三方合并逻辑
│   └── utils/                   # 文件夹变更检测、记录更新等
├── src/crypto/                  # 端到端加密 (AES-256-GCM, PBKDF2)
├── src/fs/                      # 文件系统抽象层
│   └── fs.interface.ts          # AbstractFileSystem -> LocalVaultFileSystem / WebDAVRemoteFileSystem
├── src/services/                # 服务层
│   ├── sync-executor.service.ts # 创建 NutstoreSync 实例并执行
│   ├── scheduled-sync.service.ts# 定时同步
│   ├── realtime-sync.service.ts # 实时同步 (文件变更监听)
│   ├── webdav.service.ts        # WebDAV 客户端工厂 + 连接检查
│   └── command.service.ts       # 命令注册
├── src/settings/                # 设置面板 (分页签: account/common/filter/cache/encryption/log)
├── src/storage/                 # KV 持久化 (localforage) — sync-record / blob
├── src/events/                  # RxJS 事件系统 (sync-start/end/progress/error/cancel)
├── src/api/webdav.ts            # 手写 PROPFIND (支持分页, 兼容坚果云)
├── src/webdav-patch.ts          # Monkey-patch webdav 库使用 Obsidian requestUrl (绕过 CORS)
├── src/i18n/                    # 中英双语 (i18next)
└── src/components/              # Obsidian Modal 组件
```

### 双向同步决策流程

1. `NutstoreSync.start()` 遍历 local + remote 文件系统获取文件状态
2. `TwoWaySyncDecider.decide()` 将 local/remote/record 三路状态对比，生成任务列表
3. 决策矩阵: 根据文件是否存在于 local、remote、record，以及 mtime/SHA-256 判断变更，生成对应的 Pull/Push/ConflictResolve/Noop/Remove 任务
4. `LOOSE` 模式: 无记录时文件大小相同则视为 Noop
5. 任务优化: 合并父子目录的 mkdir 任务、合并 remove 任务
6. 分批执行 (200 个/批)，503 自动等待 60 秒重试

### 关键设计

- **Task 模式**: 所有同步操作为 `BaseTask` 子类，统一 `exec()` → `TaskResult` 接口
- **Monkey-patch webdav 库**: `src/webdav-patch.ts` 让所有 WebDAV 请求走 Obsidian 的 `requestUrl`，绕过浏览器 CORS 限制（Electron/移动端部分场景仍需此方案）
- **文件内容去重**: 同步记录 base 字段存储文件 SHA-256 哈希值，决策时对比避免误判修改
- **Monorepo**: `packages/webdav-explorer` 是独立的 WebDAV 文件浏览器扩展

## 测试

```bash
bun test                          # 运行所有测试
bun test src/sync/core/merge-utils.test.ts  # 单个测试文件
```

vitest 配置将 `obsidian` 映射到 `__mocks__/obsidian.ts`，`~` 别名映射到 `src/`。
