/**
 * 加密相关类型定义
 */

/** 加密文件的 header 结构 */
export interface FileHeader {
  /** 随机 nonce (12 bytes)，用于 AES-GCM */
  nonce: Uint8Array
  /** 加密后的数据（含 16 bytes GCM 认证标签） */
  ciphertext: ArrayBuffer
}

/** data.json 中加密配置的结构 */
export interface EncryptionSettings {
  /** 是否启用加密 */
  enabled: boolean
  /** SecretStorage 中的 key ID */
  secretId: string
  /** PBKDF2 salt (base64) */
  salt: string
  /** SHA-256(rawKey) hex，用于密码验证 */
  keyHash: string
}
