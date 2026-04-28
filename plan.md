# 加密远程存储 — 实施方案

## 目标

对同步到 WebDAV 的文件内容进行端到端加密，确保：
- 远端存储的始终是密文，服务器无法读取
- 本地文件保持明文，用户无感知
- 不影响现有增量同步和冲突解决逻辑
- 移动端和桌面端均可使用

---

## 1. 架构总览

```
本地 vault (明文)                      远端 WebDAV (密文)
┌──────────────┐                    ┌─────────────────────────┐
│  note.md     │                    │  note.md                │
│  "hello"     │                    │  OBSENC + nonce + enc() │
└──────┬───────┘                    └────────▲────────────────┘
       │ PushTask: readBinary               │ putFileContents
       │ → encrypt()                        │
       │                                     │
       │ PullTask: writeBinary               │
       └─────────────────────────────────────┘
                  decrypt() ← getFileContents
```

加解密层插入在 `readBinary`/`writeBinary` 与 `putFileContents`/`getFileContents` 之间，Task 自身逻辑不变。

---

## 2. 文件加密格式

每个加密文件由 Header + Ciphertext 组成：

```
┌──────────────────────────────────────┐
│  Header (明文，19 bytes)              │
│  ├── magic:     "OBSENC"  (6 bytes)  │  识别加密文件
│  ├── version:   0x01      (1 byte)   │  格式版本
│  └── nonce:     随机      (12 bytes) │  AES-GCM IV
├──────────────────────────────────────┤
│  Ciphertext + Auth Tag               │  AES-256-GCM 加密的原始内容
│  (原始文件大小 + 16 bytes tag)        │
└──────────────────────────────────────┘
```

**设计要点：**
- `magic` 用于快速判断文件是否加密，实现向前兼容（旧明文文件不加 header）
- `nonce` 每次随机，确保同一文件加密结果不同
- GCM 自带认证标签，检测篡改

---

## 3. 目录结构（新增文件）

```
src/crypto/
├── index.ts               # 公开 API：encrypt(), decrypt(), deriveKey()
├── cipher.ts              # AES-256-GCM 加解密实现
├── key-derivation.ts      # PBKDF2 密钥派生
├── key-store.ts           # SecretStorage 读写 + 密码验证
├── file-header.ts         # 加密文件 header 读写
└── types.ts               # 类型定义
```

---

## 4. 加密方案

### 4.1 算法选择

| 组件 | 算法 | 参数 |
|---|---|---|
| 对称加密 | AES-256-GCM | keySize: 256, tagLength: 128 |
| 密钥派生 | PBKDF2 | hash: SHA-256, iterations: 600000 |
| 哈希验证 | SHA-256 | 用于验证密码正确性 |

全部使用浏览器内置 `crypto.subtle`（Web Crypto API），零外部依赖。

### 4.2 加解密核心实现

```typescript
// src/crypto/cipher.ts

const HEADER_SIZE = 19  // 6 magic + 1 version + 12 nonce

/**
 * 加密 ArrayBuffer → 带 header 的密文 ArrayBuffer
 */
async function encrypt(plaintext: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    plaintext
  )
  return packHeader(nonce, ciphertext)
}

/**
 * 解密带 header 的密文 ArrayBuffer → 明文 ArrayBuffer
 * 如果文件不以 OBSENC 开头，视为明文直接返回
 */
async function decrypt(wireData: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
  if (!isEncrypted(wireData)) {
    return wireData  // 明文文件，兼容旧数据
  }
  const { nonce, ciphertext } = unpackHeader(wireData)
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    ciphertext
  )
}
```

### 4.3 密钥派生

```typescript
// src/crypto/key-derivation.ts

/**
 * 从用户密码 + salt 派生 AES-256 密钥
 */
async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2', false, ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}
```

### 4.4 密钥存储（Obsidian SecretStorage）

```
用户密码
    │ PBKDF2 + salt
    ▼
256-bit AES key (hex 编码)
    │
    └──▶ app.secretStorage.setSecret("nutstore-encryption-key", hexKey)
         │
         ▼
    data.json: { encryption: { enabled, secretId, salt, keyHash } }
```

```typescript
// src/crypto/key-store.ts

import { App } from 'obsidian'

const SECRET_ID = 'nutstore-encryption-key'

/**
 * 首次设置加密：生成密钥 → 存 SecretStorage → 存元数据到 data.json
 */
async function setupEncryption(app: App, password: string, settings: NutstoreSettings): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(32))
  const key = await deriveKey(password, salt)
  const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key))
  const hexKey = buf2hex(rawKey)

  // 存密钥到 SecretStorage
  app.secretStorage.setSecret(SECRET_ID, hexKey)

  // 计算 keyHash 用于后续密码验证（不暴露密钥本身）
  const hash = await crypto.subtle.digest('SHA-256', rawKey)

  settings.encryption = {
    enabled: true,
    secretId: SECRET_ID,
    salt: buf2base64(salt),
    keyHash: buf2hex(new Uint8Array(hash)),
  }
  await saveSettings()
}

/**
 * 加载密钥：从 SecretStorage 读取 → 验证 hash → 导入 CryptoKey
 */
async function loadEncryptionKey(app: App, settings: NutstoreSettings): Promise<CryptoKey | null> {
  const { secretId, keyHash } = settings.encryption
  const hexKey = app.secretStorage.getSecret(secretId)
  if (!hexKey) return null

  const rawKey = hex2buf(hexKey)
  const hash = await crypto.subtle.digest('SHA-256', rawKey)
  if (buf2hex(new Uint8Array(hash)) !== keyHash) return null

  return crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/**
 * 验证密码：重新派生密钥 → 比较 hash
 */
async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  const key = await deriveKey(password, base642buf(salt))
  const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key))
  const hash = await crypto.subtle.digest('SHA-256', rawKey)
  return buf2hex(new Uint8Array(hash)) === expectedHash
}
```

---

## 5. Settings 变更

### 5.1 新增字段

```typescript
// src/settings/index.ts

interface NutstoreSettings {
  // ... 现有字段 ...

  encryption: {
    /** 是否启用加密 */
    enabled: boolean
    /** SecretStorage 中的 key ID */
    secretId: string                  // "nutstore-encryption-key"
    /** PBKDF2 salt (base64) */
    salt: string
    /** SHA-256(rawKey) hex，用于密码验证 */
    keyHash: string
  }

  // 原 webdavPassword 保留用于 WebDAV 认证，与加密密码无关
}
```

### 5.2 默认值

```typescript
const DEFAULT_SETTINGS: NutstoreSettings = {
  // ... 现有默认值 ...
  encryption: {
    enabled: false,
    secretId: 'nutstore-encryption-key',
    salt: '',
    keyHash: '',
  }
}
```

### 5.3 Settings UI

```typescript
// src/settings/encryption.ts  (新文件)

import { App, PluginSettingTab, SecretComponent, Setting } from 'obsidian'
import type NutstorePlugin from '~/index'

export class EncryptionSettings {
  constructor(
    private app: App,
    private plugin: NutstorePlugin,
    private tab: PluginSettingTab,
    private containerEl: HTMLElement,
  ) {}

  display(): void {
    const { containerEl, plugin } = this

    new Setting(containerEl)
      .setName('启用端到端加密')
      .setDesc('文件上传到 WebDAV 前加密，下载后解密。密码只存本地，无法找回。')
      .addToggle(toggle => toggle
        .setValue(plugin.settings.encryption.enabled)
        .onChange(async (enabled) => {
          if (enabled) {
            // 弹出密码设置对话框
            await this.showPasswordSetup()
          } else {
            plugin.settings.encryption.enabled = false
            await plugin.saveSettings()
          }
        }))

    if (plugin.settings.encryption.enabled) {
      new Setting(containerEl)
        .setName('加密密钥')
        .setDesc('选择或创建 SecretStorage 中的密钥')
        .addComponent(el => new SecretComponent(this.app, el)
          .setValue(plugin.settings.encryption.secretId)
          .onChange(async (secretId) => {
            plugin.settings.encryption.secretId = secretId
            await plugin.saveSettings()
          }))

      new Setting(containerEl)
        .setName('修改密码')
        .setDesc('修改密码后需要重新加密所有远端文件')
        .addButton(btn => btn
          .setButtonText('修改')
          .onClick(() => this.showPasswordChange()))
    }
  }

  private async showPasswordSetup() { /* 密码输入 + 确认 Modal */ }
  private async showPasswordChange() { /* 旧密码验证 + 新密码设置 Modal */ }
}
```

---

## 6. Task 层改动

### 6.1 改动范围

只需修改 3 个 Task 的 `exec()` 方法，插入加解密调用：

| Task | 改动 | 代码量 |
|---|---|---|
| `PushTask` | `readBinary` 后 `encrypt()` | +2 行 |
| `PullTask` | `getFileContents` 后 `decrypt()` | +2 行 |
| `ConflictResolveTask` | 读两端后各自 `decrypt()`，写回前 `encrypt()` | +6 行 |

### 6.2 PushTask

```typescript
// src/sync/tasks/push.task.ts

async exec() {
  try {
    const exists = await this.vault.adapter.exists(this.localPath)
    if (!exists) throw new Error('cannot find file in local fs: ' + this.localPath)

    let content = await this.vault.adapter.readBinary(this.localPath)

    // === 新增：加密 ===
    if (this.options.encryptionKey) {
      content = await encrypt(content, this.options.encryptionKey)
    }

    const res = await this.webdav.putFileContents(this.remotePath, content, { overwrite: true })
    if (!res) throw new Error('Upload failed')
    return { success: res }
  } catch (e) {
    logger.error(this, e)
    return { success: false, error: toTaskError(e, this) }
  }
}
```

### 6.3 PullTask

```typescript
// src/sync/tasks/pull.task.ts

async exec() {
  try {
    const file = await this.webdav.getFileContents(this.remotePath, {
      format: 'binary', details: false,
    }) as BufferLike

    let arrayBuffer = bufferLikeToArrayBuffer(file)

    // === 新增：解密 ===
    if (this.options.encryptionKey) {
      arrayBuffer = await decrypt(arrayBuffer, this.options.encryptionKey)
    }

    await mkdirsVault(this.vault, dirname(this.localPath))
    await this.vault.adapter.writeBinary(this.localPath, arrayBuffer)
    return { success: true } as const
  } catch (e) {
    logger.error(this, e)
    return { success: false, error: toTaskError(e, this) }
  }
}
```

### 6.4 ConflictResolveTask

```typescript
// 在 execIntelligentMerge / execLatestTimeStamp 中

// 读取时解密两端
let localBuffer = await this.vault.adapter.readBinary(this.localPath)
let remoteBuffer = await this.webdav.getFileContents(...)

if (encryptionKey) {
  localBuffer = await decrypt(localBuffer, encryptionKey)
  remoteBuffer = await decrypt(remoteBuffer, encryptionKey)
}

// ... 合并逻辑 ...

// 写回时加密
if (encryptionKey) {
  mergedBuffer = await encrypt(mergedBuffer, encryptionKey)
}
await this.webdav.putFileContents(this.remotePath, mergedBuffer, { overwrite: true })
```

### 6.5 BaseTaskOptions 变更

```typescript
// src/sync/tasks/task.interface.ts

interface BaseTaskOptions {
  vault: Vault
  webdav: WebDAVClient
  remoteBaseDir: string
  remotePath: string
  localPath: string
  syncRecord: SyncRecord
  encryptionKey?: CryptoKey | null   // === 新增 ===
}
```

---

## 7. 增量同步的兼容处理

### 7.1 问题

当前增量同步依赖 `sync record` 存储文件的 mtime 和 base blob（用于三方合并的原始版本）：

```typescript
interface SyncRecordModel {
  local: StatModel    // mtime, size
  remote: StatModel   // mtime, size
  base?: { key: string }  // blobStore 中的 base 内容
}
```

加密后两个问题：
1. **base blob** 存的是明文，但远端是密文 → 三方合并需要先解密远端再比较
2. **size** 加密后增大约 35 bytes → record 中存的应该是加密后的 size

### 7.2 处理方案

```
SyncRecordModel 不变，但含义调整：
  local.stat  → 明文 mtime + 明文 size（本地文件属性）
  remote.stat → 远端 mtime + 加密后 size（远端文件属性）
  base.key    → 明文 base 的 blob key（合并时需要，本地已有解密能力）
```

**解密时机：** `ConflictResolveTask` 中读远端文件后立即解密，解密后的内容与 `base`（明文）一致，三方合并逻辑不变。

**size 判断：** `twoWayDecider` 中 `skipLargeFiles` 比较时，`local.size` 用明文大小，`remote.size` 已经是加密后的大小（从 `webdav.stat` 获取），无需额外处理。

**PushTask 的 base 更新：** `updateMtimeInRecord` 中存 base 时仍然存明文 blob（本地可读取），远端也存对应的明文 base 用于下次三方合并。

---

## 8. 密码管理

### 8.1 密码生命周期

```
首次设置 → 输入密码 → PBKDF2 派生 → 存 SecretStorage + data.json 元数据
   │
   ▼
每次同步 → 从 SecretStorage 读取 hexKey → 导入 CryptoKey → 加解密
   │
   ▼
修改密码 → 验证旧密码 → 新密码派生新 key → 存 SecretStorage
         → 全量重新加密远端文件（用旧 key 解密，新 key 加密）
```

### 8.2 密码修改实现

```typescript
async function changePassword(app: App, oldPwd: string, newPwd: string): Promise<void> {
  // 1. 验证旧密码
  if (!await verifyPassword(oldPwd, settings.encryption.salt, settings.encryption.keyHash)) {
    throw new Error('密码错误')
  }

  // 2. 加载旧 key
  const oldKey = await loadEncryptionKey(app, settings)

  // 3. 生成新 key
  const newSalt = crypto.getRandomValues(new Uint8Array(32))
  const newKey = await deriveKey(newPwd, newSalt)

  // 4. 存储新 key
  const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', newKey))
  app.secretStorage.setSecret(SECRET_ID, buf2hex(rawKey))

  // 5. 更新 data.json
  const hash = await crypto.subtle.digest('SHA-256', rawKey)
  settings.encryption = { ...settings.encryption, salt: buf2base64(newSalt), keyHash: buf2hex(hash) }
  await saveSettings()

  // 6. 全量重新加密远端文件（后台执行）
  await reEncryptAllRemoteFiles(oldKey, newKey)
}
```

### 8.3 忘记密码

**无法恢复。** 需在 UI 明确警告：

> ⚠️ 密码无法找回。如果忘记密码，远端加密文件将永久无法解密。
> 建议将密码保存在安全的密码管理器中。

---

## 9. 向前兼容（明文→密文迁移）

### 9.1 检测机制

通过 magic header `OBSENC` 判断文件是否为密文：

```typescript
// src/crypto/file-header.ts

const MAGIC = new TextEncoder().encode('OBSENC')  // [79, 66, 83, 69, 78, 67]

function isEncrypted(data: ArrayBuffer): boolean {
  if (data.byteLength < 6) return false
  const header = new Uint8Array(data, 0, 6)
  return header.every((b, i) => b === MAGIC[i])
}
```

### 9.2 迁移流程

```
启用加密前:  远端全是明文文件
     │
     ▼
用户启用加密 → 弹出确认 Modal:
  "检测到远端有 N 个明文文件，是否迁移加密？"
     │
     ├─ [跳过] → 不处理旧文件，仅新同步的文件加密
     │           未来同步时明文文件仍正常同步（双向兼容）
     │
     └─ [迁移] → 后台逐一下载明文 → 加密 → 上传覆盖
                  进度条显示 "正在加密 N/N 文件..."
```

### 9.3 双向兼容保证

- 启用加密后：新 Push 的文件加密上传；Pull 时自动检测 header
- 禁用加密后：新 Push 的文件明文上传；Pull 时仍能解密旧加密文件（如果 key 还在）
- 混合状态：允许远端同时存在明文和密文文件，各自正常处理

---

## 10. 移动端兼容

| 组件 | 桌面端 (Electron) | 移动端 (Capacitor) |
|---|---|---|
| Web Crypto API (`crypto.subtle`) | ✅ 完全支持 | ✅ 完全支持 |
| `PBKDF2` 600000 iter | ✅ < 1s | ⚠️ 可能较慢，考虑降为 100000 |
| `SecretStorage` | ✅ 可用 | ✅ 可用 |
| `SecretComponent` | ✅ 可用 | ✅ 可用 |

移动端 PBKDF2 迭代次数建议：

```typescript
const ITERATIONS = Platform.isMobileApp ? 100_000 : 600_000
```

---

## 11. 实施步骤（分 5 个阶段）

### 阶段 1：加密基础设施

| 步骤 | 产出 | 预估 |
|---|---|---|
| 1.1 | 创建 `src/crypto/cipher.ts` — AES-256-GCM 加解密 | 0.5h |
| 1.2 | 创建 `src/crypto/key-derivation.ts` — PBKDF2 密钥派生 | 0.5h |
| 1.3 | 创建 `src/crypto/file-header.ts` — 文件 header 读写 | 0.5h |
| 1.4 | 创建 `src/crypto/key-store.ts` — SecretStorage 集成 | 1h |
| 1.5 | 创建 `src/crypto/index.ts` — 公开 API | 0.5h |
| 1.6 | 编写单元测试 | 1h |

### 阶段 2：Task 层改造

| 步骤 | 产出 | 预估 |
|---|---|---|
| 2.1 | `BaseTaskOptions` 增加 `encryptionKey` | 0.25h |
| 2.2 | `PushTask.exec()` 增加 `encrypt()` | 0.25h |
| 2.3 | `PullTask.exec()` 增加 `decrypt()` | 0.25h |
| 2.4 | `ConflictResolveTask` 增加解密再比较再加密 | 0.5h |
| 2.5 | `NutstoreSync.start()` 注入 `encryptionKey` 到 task 构造 | 0.5h |

### 阶段 3：Settings & UI

| 步骤 | 产出 | 预期 |
|---|---|---|
| 3.1 | `NutstoreSettings` 增加 `encryption` 字段 | 0.25h |
| 3.2 | 创建 `src/settings/encryption.ts` — 加密设置页 | 1h |
| 3.3 | 密码设置 Modal（输入密码 + 确认） | 1h |
| 3.4 | 集成到 `NutstoreSettingTab` | 0.5h |

### 阶段 4：迁移 & 兼容

| 步骤 | 产出 | 预期 |
|---|---|---|
| 4.1 | 实现明文→密文迁移流程（全量加密 Modal） | 1h |
| 4.2 | 密码修改 + 全量重加密 | 1h |
| 4.3 | 增量同步兼容处理（base blob / size） | 1h |
| 4.4 | 移动端 PBKDF2 迭代数适配 | 0.25h |

### 阶段 5：测试 & 文档

| 步骤 | 产出 | 预期 |
|---|---|---|
| 5.1 | 加解密单元测试（各种文件大小、空文件、二进制） | 1h |
| 5.2 | 端到端测试（明文↔密文双向兼容） | 1h |
| 5.3 | 移动端验证 | 0.5h |
| 5.4 | 更新 README + CHANGELOG | 0.5h |

**总预估：约 12 小时**

---

## 12. 风险 & 已知限制

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| 忘记密码 | 远端文件全部不可恢复 | 设置页显著警告；建议用户备份密码 |
| SecretStorage 被清除 | 密钥丢失，远端文件不可读 | 导出/备份功能（可选扩展） |
| 密码修改后远端重加密中断 | 远端部分密文用旧 key，部分用新 key | 重加密操作需原子化 + 重试；支持多 key 解密 |
| 移动端 PBKDF2 慢 | 首次设置/修改密码时卡顿 | 降低迭代数；显示 loading 提示 |
| 文件名/目录结构泄露 | 服务器可看到文件名和目录层级 | 暂不处理（加密文件名会使 sync record 匹配失败） |

---

## 13. 未覆盖项（后续版本）

- **文件名加密**：当前设计不加密文件名，服务器可见文件路径。如需完全隐私，后续版本可加密索引文件
- **同步 record 加密**：`syncRecordKV` 中存储的 mtime/size/base 是明文。如需要，可用相同 key 加密 record
- **密钥导出/导入**：跨设备同步密钥（结合 SecretStorage 的共享能力）
- **审查日志**：记录加解密操作的时间线，便于审计
