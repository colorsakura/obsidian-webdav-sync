# 🔄 Nutstore Sync

## Introduction | 简介

This plugin enables two-way synchronization between Obsidian notes and Nutstore via WebDAV protocol.

此插件允许您通过 WebDAV 协议将 Obsidian 笔记与坚果云进行双向同步。

---

## ✨ Key Features | 主要特性

- 🔄 **Two-way Sync**: Efficiently synchronize your notes across devices
- ⚡ **Incremental Sync**: Fast updates that only transfer changed files, making large vaults sync quickly
- 🔒 **End-to-End Encryption**: AES-256-GCM encryption ensures your files are encrypted on the server. Only your password can decrypt them.
- 🔐 **Single Sign-On**: Connect to Nutstore with simple authorization instead of manually entering WebDAV credentials
- 📁 **WebDAV Explorer**: Visual file browser for remote file management
- 🔀 **Smart Conflict Resolution**:
  - Character-level comparison to automatically merge changes when possible
  - Option to use timestamp-based resolution (newest file wins)
- 🚀 **Loose Sync Mode**: Optimize performance for vaults with thousands of notes
- 📦 **Large File Handling**: Set size limits to skip large files for better performance
- 📊 **Sync Status Tracking**: Clear visual indicators of sync progress and completion
- 📝 **Detailed Logging**: Comprehensive logs for troubleshooting

<br>

- 🔄 **双向同步**: 高效地在多设备间同步笔记
- ⚡ **增量同步**: 只传输更改过的文件，使大型笔记库也能快速同步
- 🔒 **端到端加密**: AES-256-GCM 加密确保文件在服务器上以密文存储，只有您的密码才能解密
- 🔐 **单点登录**: 通过简单授权连接坚果云，无需手动输入 WebDAV 凭据
- 📁 **WebDAV 文件浏览器**: 远程文件管理的可视化界面
- 🔀 **智能冲突解决**:
  - 字符级比较自动合并可能的更改
  - 支持基于时间戳的解决方案（最新文件优先）
- 🚀 **宽松同步模式**: 优化对包含数千笔记的仓库的性能
- 📦 **大文件处理**: 设置大小限制以跳过大文件，提升性能
- 📊 **同步状态跟踪**: 清晰的同步进度和完成提示
- 📝 **详细日志**: 全面的故障排查日志

---

## ⚠️ Important Notes | 注意事项

- ⏳ Initial sync may take longer (especially with many files)
- 💾 Please backup before syncing

<br>

- ⏳ 首次同步可能需要较长时间 (文件比较多时)
- 💾 请在同步之前备份

---

## 🔒 End-to-End Encryption | 端到端加密

### How to Enable | 如何启用

1. Go to **Settings → Nutstore Sync → 端到端加密**
2. Toggle **启用端到端加密**
3. Enter and confirm your password (at least 8 characters)
4. Click **确认设置**

### Migration | 迁移

After enabling encryption, existing plaintext files on the remote server remain unencrypted. To encrypt them:

1. Click **开始迁移** in the encryption settings
2. Review the file scan results
3. Click **开始迁移** to encrypt all plaintext files

### Important Warnings | 重要警告

- ⚠️ **Password cannot be recovered.** If you forget your password, remote encrypted files will be permanently unreadable.
- ⚠️ The password is stored locally in Obsidian's SecretStorage, never transmitted to any server.
- ⚠️ It is recommended to save your password in a secure password manager.

### How It Works | 工作原理

- **Encryption**: AES-256-GCM, files are encrypted before upload
- **Key Derivation**: PBKDF2 with SHA-256 (600,000 iterations on desktop, 100,000 on mobile)
- **Storage**: Encryption key is stored in Obsidian's SecretStorage
- **Compatibility**: Plaintext and encrypted files can coexist; the plugin auto-detects the format

---

## ⚠️ Important Notes | 注意事项
