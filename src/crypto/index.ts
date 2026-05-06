/**
 * crypto — 加密模块公开 API
 *
 * 端到端加密，确保 WebDAV 远端文件以密文存储，
 * 本地文件保持明文，用户无感知。
 */

export { encrypt, decrypt } from './cipher'
export { compressGzip, decompressGzip } from './compression'
export { deriveKey, getPBKDF2Iterations } from './key-derivation'
export {
	isEncrypted,
	isCompressed,
	HEADER_SIZE,
	GCM_TAG_SIZE,
	ENCRYPTION_OVERHEAD,
	FLAG_COMPRESSED,
} from './file-header'
export {
	setupEncryption,
	loadEncryptionKey,
	verifyPassword,
	restoreEncryption,
	SECRET_ID,
} from './key-store'
export {
	detectRemoteFiles,
	migrateToEncrypted,
	reEncryptAllFiles,
	filterPlainFiles,
	sampleRemoteEncryption,
	repairLocalEncryptedFiles,
	findLocalEncryptedFiles,
	walkLocalFiles,
} from './migration'
export { showRestoreKeyModal } from './password-modal'
export type {
	MigrationFileInfo,
	MigrationProgressCallback,
	EncryptedFileInfo,
} from './migration'
export type { EncryptionSettings, FileHeader } from './types'
