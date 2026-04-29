# 新设备加密检测与密钥恢复设计

## 问题

全新设备同步时，如果远程数据已加密但本地未配置加密（或密钥缺失），当前行为：
- `settings.encryption.enabled = false`：同步正常运行，加密文件被当作二进制原样下载，本地得到乱码
- `settings.encryption.enabled = true` 但 SecretStorage 中无密钥：显示 Notice 提示但同步继续，结果同上

需要：首次同步时自动检测远程加密状态，阻断同步并要求用户输入密码恢复密钥。

## 范围

- 仅在**本地无同步记录**（新设备）时触发检测
- 自动采样远程文件头部 `OBSENC` 魔术字节判断加密状态
- 弹出 Modal 阻断同步，要求输入密码
- 密码正确 → 恢复密钥到 SecretStorage，启用加密设置，继续同步
- 用户取消 → 中止同步

## 实现

### 1. 新增 `sampleRemoteEncryption()` 函数

**位置**: `src/crypto/migration.ts`（与现有 `detectRemoteFiles` 同文件）

**签名**: `sampleRemoteEncryption(webdav, remoteBaseDir, maxFiles = 3): Promise<boolean>`

**逻辑**:
- 对 `remoteBaseDir` 做浅层 PROPFIND，获取文件列表
- 取前 `maxFiles` 个文件，通过 Range 请求读取前 6 字节
- 任一文件以 `OBSENC` 开头即返回 `true`
- 没有文件或全部非加密返回 `false`

与现有 `detectRemoteFiles` 的区别：`detectRemoteFiles` 递归遍历全部文件并返回详细信息，用于迁移流程。`sampleRemoteEncryption` 只采样少量文件快速判断，用于同步前置检测。

### 2. 修改 `NutstoreSync.start()`

**文件**: `src/sync/index.ts`

在 `loadEncryptionKey()` 返回 null 后插入检测逻辑：

```
encryptionKey = await loadEncryptionKey(...)

if (!encryptionKey) {
    // 新设备 + 远程加密检测
    records = await syncRecordStorage.getRecords()
    if (records.size === 0) {
        const remoteEncrypted = await sampleRemoteEncryption(webdav, remoteBaseDir)
        if (remoteEncrypted) {
            // 弹出密码 Modal，等待用户输入
            const password = await showSyncPasswordModal()
            if (!password) {
                // 用户取消，中止同步
                return
            }
            // 恢复密钥
            const ok = await restoreEncryption(app, password, settings.encryption)
            if (!ok) {
                new Notice('密码错误，请重试')
                return
            }
            settings.encryption.enabled = true
            await saveSettings()
            encryptionKey = await loadEncryptionKey(app, settings.encryption)
        }
    } else if (settings.encryption.enabled) {
        // 有记录但密钥缺失（非新设备），保留现有 Notice 提示
        new Notice('加密密钥未找到，请在设置 → 加密中恢复密钥', 8000)
    }
}
```

### 3. 新增 `showSyncPasswordModal()`

**位置**: `src/crypto/password-modal.ts`（新建，从 `src/settings/encryption.ts` 中提取共用逻辑）

**行为**:
- 打开 Obsidian Modal，包含密码输入框和确认/取消按钮
- 标题："检测到远程数据已加密，请输入密码恢复密钥"
- 显示 PBKDF2 迭代次数信息
- 返回 Promise，确认时 resolve 密码，取消时 resolve null

`settings/encryption.ts` 中的 `showPasswordRestoreModal` 改为调用同一个函数。

### 4. 导出更新

`src/crypto/index.ts` 添加 `sampleRemoteEncryption` 和 `showSyncPasswordModal` 的导出。

## 关键边界

- **无远程文件**：`sampleRemoteEncryption` 返回 false，不触发密码弹窗
- **用户取消**：同步中止，不修改任何设置
- **密码错误**：显示提示，不重试（用户可手动再次触发同步）
- **网络错误**：采样失败时不阻塞同步，降级为现有行为（显示 Notice）
- **已有同步记录**：不触发检测，保持向后兼容

## 测试要点

- 新设备 + 远程加密 + 正确密码 → 恢复密钥，同步成功
- 新设备 + 远程加密 + 错误密码 → 提示错误，同步中止
- 新设备 + 远程加密 + 用户取消 → 同步中止
- 新设备 + 远程无加密 → 正常同步
- 旧设备（有记录）+ 密钥缺失 → 显示 Notice，不弹 Modal
- 远程无文件 → 正常同步
