/**
 * crypto — 加密模块公开 API
 *
 * 端到端加密，确保 WebDAV 远端文件以密文存储，
 * 本地文件保持明文，用户无感知。
 */

export { encrypt, decrypt } from './cipher'
export { deriveKey, getPBKDF2Iterations } from './key-derivation'
export { isEncrypted, HEADER_SIZE, GCM_TAG_SIZE, ENCRYPTION_OVERHEAD } from './file-header'
export {
  setupEncryption,
  loadEncryptionKey,
  verifyPassword,
  SECRET_ID,
} from './key-store'
export {
  detectRemoteFiles,
  migrateToEncrypted,
  reEncryptAllFiles,
  filterPlainFiles,
} from './migration'
export type {
  MigrationFileInfo,
  MigrationProgressCallback,
} from './migration'
export type { EncryptionSettings, FileHeader } from './types'
