# 新设备加密检测与密钥恢复 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全新设备首次同步时自动检测远程加密数据，弹出密码输入 Modal 阻断同步，用户输入正确密码后恢复密钥继续同步。

**Architecture:** 在 `src/crypto/migration.ts` 新增轻量级采样函数 `sampleRemoteEncryption`；在 `src/crypto/password-modal.ts` 新建共用密码恢复弹窗；在 `NutstoreSync.start()` 的 `loadEncryptionKey()` 返回 null 后插入检测逻辑，阻断同步直到密码正确或用户取消。

**Tech Stack:** TypeScript, Obsidian API (Modal, Notice, App, SecretStorage), WebDAV client (webdav v5.9), AES-256-GCM Web Crypto API

---

### Task 1: 新增 `sampleRemoteEncryption` 采样函数

**Files:**
- Modify: `src/crypto/migration.ts`

- [ ] **Step 1: 在 `detectRemoteFiles` 函数之后添加 `sampleRemoteEncryption` 函数**

```typescript
/**
 * 快速采样检测远端是否为加密数据
 *
 * 浅遍历 remoteBaseDir，取前 maxFiles 个文件读取前 6 字节，
 * 检查是否有 OBSENC 魔术头。任意一个命中即返回 true。
 * 用于同步前置检测（如新设备场景），不做全量递归。
 *
 * @param webdav - WebDAV 客户端
 * @param remoteBaseDir - 远端根目录
 * @param maxFiles - 最多采样文件数，默认 3
 * @returns true 表示检测到加密文件
 */
export async function sampleRemoteEncryption(
    webdav: WebDAVClient,
    remoteBaseDir: string,
    maxFiles: number = 3,
): Promise<boolean> {
    try {
        const contents = await webdav.getDirectoryContents(remoteBaseDir)
        const items = Array.isArray(contents) ? contents : [contents]
        const files = items.filter((item: any) => item.type === 'file')

        let checked = 0
        for (const file of files) {
            if (checked >= maxFiles) break
            try {
                const headerData = (await webdav.getFileContents(file.filename, {
                    format: 'binary',
                    details: false,
                    headers: {
                        Range: 'bytes=0-5',
                    },
                })) as BufferLike
                const headerBuffer = bufferLikeToArrayBuffer(headerData)
                if (isEncrypted(headerBuffer)) {
                    return true
                }
                checked++
            } catch {
                // 单个文件读取失败，跳过
            }
        }
        return false
    } catch {
        // PROPFIND 失败（如目录不存在），不阻塞同步
        return false
    }
}
```

- [ ] **Step 2: 验证 TypeScript 编译通过**

```bash
bun run tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/crypto/migration.ts
git commit -m "feat: add sampleRemoteEncryption for quick remote encryption detection"
```

---

### Task 2: 新建共用密码恢复 Modal

**Files:**
- Create: `src/crypto/password-modal.ts`

- [ ] **Step 1: 创建 `showRestoreKeyModal` 函数**

```typescript
/**
 * 共用密码恢复 Modal
 *
 * 用于同步前置检测和设置页面的密钥恢复场景。
 * 用户输入密码 → 调用 restoreEncryption → 返回结果。
 */

import { App, Modal, Setting } from 'obsidian'
import type { EncryptionSettings } from './types'
import { restoreEncryption } from './key-store'

export function showRestoreKeyModal(
    app: App,
    encryption: EncryptionSettings,
    title: string,
    description: string,
): Promise<string | null> {
    return new Promise((resolve) => {
        const modal = new Modal(app)
        modal.titleEl.setText(title)

        const contentEl = modal.contentEl
        contentEl.createEl('p', { text: description })

        let passwordInput: HTMLInputElement
        let errorEl: HTMLElement

        new Setting(contentEl).setName('密码').addText((text) => {
            text.inputEl.type = 'password'
            text.inputEl.placeholder = '输入加密密码'
            passwordInput = text.inputEl
        })

        errorEl = contentEl.createDiv({ cls: 'nutstore-encryption-error' })
        errorEl.style.color = 'var(--text-error)'
        errorEl.style.display = 'none'

        new Setting(contentEl).addButton((btn) =>
            btn.setButtonText('取消').onClick(() => {
                modal.close()
                resolve(null)
            }),
        )

        new Setting(contentEl).addButton((btn) => {
            btn
                .setButtonText('确认')
                .setCta()
                .onClick(async () => {
                    const password = passwordInput.value
                    if (!password) {
                        errorEl.setText('请输入密码')
                        errorEl.style.display = 'block'
                        return
                    }

                    btn.setDisabled(true)
                    btn.setButtonText('正在恢复密钥...')

                    try {
                        const success = await restoreEncryption(
                            app,
                            password,
                            encryption,
                        )
                        if (!success) {
                            errorEl.setText('密码错误，请重试')
                            errorEl.style.display = 'block'
                            btn.setDisabled(false)
                            btn.setButtonText('确认')
                            return
                        }
                        modal.close()
                        resolve(password)
                    } catch (e) {
                        errorEl.setText('密钥恢复失败: ' + String(e))
                        errorEl.style.display = 'block'
                        btn.setDisabled(false)
                        btn.setButtonText('确认')
                    }
                })
        })

        modal.open()
    })
}
```

- [ ] **Step 2: 验证编译通过**

```bash
bun run tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/crypto/password-modal.ts
git commit -m "feat: add shared password restore modal"
```

---

### Task 3: 更新 crypto/index.ts 导出

**Files:**
- Modify: `src/crypto/index.ts`

- [ ] **Step 1: 添加 `sampleRemoteEncryption` 和 `showRestoreKeyModal` 导出**

在 `src/crypto/index.ts` 的 migration 导出区域（第 23-28 行附近）添加：

```typescript
export {
    detectRemoteFiles,
    migrateToEncrypted,
    reEncryptAllFiles,
    filterPlainFiles,
    sampleRemoteEncryption,  // 新增
} from './migration'
```

在文件末尾（或合适位置）添加：

```typescript
export { showRestoreKeyModal } from './password-modal'
```

- [ ] **Step 2: 验证编译通过**

```bash
bun run tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/crypto/index.ts
git commit -m "feat: export sampleRemoteEncryption and showRestoreKeyModal"
```

---

### Task 4: 修改 `NutstoreSync.start()` 添加加密检测与阻断

**Files:**
- Modify: `src/sync/index.ts` (行 108-118 区域)

- [ ] **Step 1: 更新 import 语句**

在第 9 行，将：
```typescript
import { loadEncryptionKey } from '~/crypto'
```
改为：
```typescript
import { loadEncryptionKey, sampleRemoteEncryption, showRestoreKeyModal } from '~/crypto'
```

- [ ] **Step 2: 替换行 107-118 的加密密钥加载 + 警告逻辑**

**原始代码** (行 107-118)：
```typescript
// 加载端到端加密密钥
const encryptionKey = await loadEncryptionKey(
    this.app,
    this.settings.encryption,
)

if (this.settings.encryption.enabled && !encryptionKey) {
    new Notice(
        '加密密钥未找到，请在设置 → 加密中恢复密钥',
        8000,
    )
}
```

**替换为**：
```typescript
// 加载端到端加密密钥
let encryptionKey = await loadEncryptionKey(
    this.app,
    this.settings.encryption,
)

if (!encryptionKey) {
    // 新设备检测：无同步记录 + 远程加密 → 弹出密码恢复 Modal
    const records = await syncRecord.getRecords()
    if (records.size === 0) {
        try {
            const remoteEncrypted = await sampleRemoteEncryption(
                webdav,
                remoteBaseDir,
            )
            if (remoteEncrypted) {
                const password = await showRestoreKeyModal(
                    this.app,
                    this.settings.encryption,
                    '检测到远程数据已加密',
                    '远程文件已使用端到端加密。请输入密码恢复密钥以继续同步。',
                )
                if (!password) {
                    // 用户取消，中止同步
                    emitSyncError(new Error(i18n.t('sync.cancelled')))
                    return
                }
                // 启用加密并保存设置
                this.settings.encryption.enabled = true
                await this.plugin.saveSettings()
                // 重新加载密钥
                encryptionKey = await loadEncryptionKey(
                    this.app,
                    this.settings.encryption,
                )
            }
        } catch {
            // 采样失败不阻塞同步
        }
    } else if (this.settings.encryption.enabled) {
        // 旧设备但密钥缺失：显示提示（保持原有行为）
        new Notice(
            '加密密钥未找到，请在设置 → 加密中恢复密钥',
            8000,
        )
    }
}
```

- [ ] **Step 3: 验证编译通过**

```bash
bun run tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add src/sync/index.ts
git commit -m "feat: block sync on new device when remote encryption detected, prompt for password"
```

---

### Task 5: 重构 settings/encryption.ts 使用共用 Modal

**Files:**
- Modify: `src/settings/encryption.ts`

- [ ] **Step 1: 更新 import**

在第 15-21 行，添加 `showRestoreKeyModal` 导入：
```typescript
import {
    getPBKDF2Iterations,
    loadEncryptionKey,
    restoreEncryption,
    setupEncryption,
    verifyPassword,
    showRestoreKeyModal,
} from '~/crypto'
```

- [ ] **Step 2: 重写 `showPasswordRestoreModal` 使用共用函数**

将原有的 `showPasswordRestoreModal` 函数（行 352-431）替换为：

```typescript
/**
 * 密码恢复 Modal（设置页面入口）
 *
 * 使用共用的 showRestoreKeyModal，成功后显示提示并刷新页面。
 */
async function showPasswordRestoreModal(
    app: App,
    plugin: NutstorePlugin,
): Promise<void> {
    const password = await showRestoreKeyModal(
        app,
        plugin.settings.encryption,
        '恢复加密密钥',
        '请输入您的加密密码。密钥将从本地配置中的 salt 恢复，不会更改加密设置。',
    )
    if (password) {
        new Notice('密钥已成功恢复', 5000)
    }
}
```

- [ ] **Step 3: 移除不再需要的 import**

`restoreEncryption` 不再直接使用，可从 import 中移除（但保留它在 crypto/index 中导出给其他模块）：
```typescript
import {
    getPBKDF2Iterations,
    loadEncryptionKey,
    setupEncryption,
    verifyPassword,
    showRestoreKeyModal,
} from '~/crypto'
```

- [ ] **Step 4: 验证编译通过**

```bash
bun run tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 5: Commit**

```bash
git add src/settings/encryption.ts
git commit -m "refactor: use shared showRestoreKeyModal in settings encryption tab"
```

---

### Task 6: 运行测试验证无回归

- [ ] **Step 1: 运行完整测试套件**

```bash
bun run test
```

预期：所有已有测试通过，无回归。

- [ ] **Step 2: 运行类型检查**

```bash
bun run tsc --noEmit
```

预期：零错误。

- [ ] **Step 3: 生产构建验证**

```bash
bun run build
```

预期：构建成功。
