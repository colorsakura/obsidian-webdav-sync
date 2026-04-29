/**
 * 加密迁移服务
 *
 * 处理明文 → 密文的迁移，以及密码修改后的重加密
 */

import { App, Notice, Vault } from 'obsidian'
import { WebDAVClient, BufferLike } from 'webdav'
import { decrypt, encrypt } from './cipher'
import { isEncrypted } from './file-header'
import { loadEncryptionKey } from './key-store'
import type { EncryptionSettings } from './types'

/**
 * 需要迁移的文件信息
 */
export interface MigrationFileInfo {
	remotePath: string
	size: number
	isEncrypted: boolean
}

/**
 * 迁移进度回调
 */
export type MigrationProgressCallback = (
	current: number,
	total: number,
	filePath: string,
) => void

/**
 * 检测远端所有文件，区分明文/密文
 *
 * @param webdav - WebDAV 客户端
 * @param remoteBaseDir - 远端根目录
 * @returns 文件列表，标记是否已加密
 */
export async function detectRemoteFiles(
	webdav: WebDAVClient,
	remoteBaseDir: string,
): Promise<MigrationFileInfo[]> {
	const files: MigrationFileInfo[] = []

	async function walk(dir: string) {
		const contents = await webdav.getDirectoryContents(dir)
		for (const item of Array.isArray(contents) ? contents : [contents]) {
			const isDir = item.type === 'directory'
			if (isDir) {
				await walk(item.filename)
			} else {
				// 只读取前 6 bytes 判断是否为加密文件
				let isEnc = false
				try {
					const headerData = (await webdav.getFileContents(item.filename, {
						format: 'binary',
						details: false,
					})) as BufferLike
					const headerBuffer = bufferLikeToArrayBuffer(headerData)
					isEnc = isEncrypted(headerBuffer)
				} catch {
					// 文件无法读取，跳过
				}
				files.push({
					remotePath: item.filename.replace(remoteBaseDir + '/', ''),
					size: item.size,
					isEncrypted: isEnc,
				})
			}
		}
	}

	await walk(remoteBaseDir)
	return files
}

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

/**
 * 执行明文 → 密文迁移
 *
 * 流程：
 * 1. 遍历远端文件
 * 2. 对每个明文文件：下载 → 加密 → 上传覆盖
 * 3. 显示进度
 *
 * @param webdav - WebDAV 客户端
 * @param remoteBaseDir - 远端根目录
 * @param encryptionKey - 加密密钥
 * @param onProgress - 进度回调
 */
export async function migrateToEncrypted(
	webdav: WebDAVClient,
	remoteBaseDir: string,
	encryptionKey: CryptoKey,
	onProgress: MigrationProgressCallback,
): Promise<{ success: number; failed: number }> {
	// 检测文件状态
	const allFiles = await detectRemoteFiles(webdav, remoteBaseDir)
	const plainFiles = allFiles.filter((f) => !f.isEncrypted)

	if (plainFiles.length === 0) {
		return { success: 0, failed: 0 }
	}

	let success = 0
	let failed = 0

	for (let i = 0; i < plainFiles.length; i++) {
		const file = plainFiles[i]
		onProgress(i + 1, plainFiles.length, file.remotePath)

		try {
			// 下载明文
			const content = (await webdav.getFileContents(
				`${remoteBaseDir}/${file.remotePath}`,
				{ format: 'binary', details: false },
			)) as BufferLike
			const arrayBuffer = bufferLikeToArrayBuffer(content)

			// 加密
			const encrypted = await encrypt(arrayBuffer, encryptionKey)

			// 上传密文
			await webdav.putFileContents(
				`${remoteBaseDir}/${file.remotePath}`,
				encrypted,
				{ overwrite: true },
			)
			success++
		} catch {
			failed++
		}
	}

	return { success, failed }
}

/**
 * 执行重加密（密码修改后）
 *
 * 流程：
 * 1. 遍历远端文件
 * 2. 对每个加密文件：下载 → 旧 key 解密 → 新 key 加密 → 上传覆盖
 *
 * @param webdav - WebDAV 客户端
 * @param remoteBaseDir - 远端根目录
 * @param oldKey - 旧加密密钥
 * @param newKey - 新加密密钥
 * @param onProgress - 进度回调
 */
export async function reEncryptAllFiles(
	webdav: WebDAVClient,
	remoteBaseDir: string,
	oldKey: CryptoKey,
	newKey: CryptoKey,
	onProgress: MigrationProgressCallback,
): Promise<{ success: number; failed: number }> {
	const allFiles = await detectRemoteFiles(webdav, remoteBaseDir)
	const encryptedFiles = allFiles.filter((f) => f.isEncrypted)

	if (encryptedFiles.length === 0) {
		return { success: 0, failed: 0 }
	}

	let success = 0
	let failed = 0

	for (let i = 0; i < encryptedFiles.length; i++) {
		const file = encryptedFiles[i]
		onProgress(i + 1, encryptedFiles.length, file.remotePath)

		try {
			// 下载密文
			const content = (await webdav.getFileContents(
				`${remoteBaseDir}/${file.remotePath}`,
				{ format: 'binary', details: false },
			)) as BufferLike
			const arrayBuffer = bufferLikeToArrayBuffer(content)

			// 用旧 key 解密
			const plaintext = await decrypt(arrayBuffer, oldKey)

			// 用新 key 加密
			const reEncrypted = await encrypt(plaintext, newKey)

			// 上传
			await webdav.putFileContents(
				`${remoteBaseDir}/${file.remotePath}`,
				reEncrypted,
				{ overwrite: true },
			)
			success++
		} catch {
			failed++
		}
	}

	return { success, failed }
}

/**
 * 检查远端是否有明文文件需要迁移
 */
export function filterPlainFiles(
	files: MigrationFileInfo[],
): MigrationFileInfo[] {
	return files.filter((f) => !f.isEncrypted)
}

function bufferLikeToArrayBuffer(buffer: BufferLike): ArrayBuffer {
	if (buffer instanceof ArrayBuffer) {
		return buffer
	}
	return toArrayBuffer(buffer as Buffer)
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
	if (buf.buffer instanceof SharedArrayBuffer) {
		const copy = new ArrayBuffer(buf.byteLength)
		new Uint8Array(copy).set(buf)
		return copy
	}
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

/**
 * 修复本地异常加密文件
 *
 * 当密钥缺失导致 PullTask 未解密就写入本地时，本地文件可能残留
 * OBSENC 密文数据。此函数遍历本地 vault 文件，对检测到加密头的
 * 文件用密钥解密后覆盖。非加密文件（decrypt 透传）不受影响。
 *
 * @param vault - Obsidian Vault 实例
 * @param encryptionKey - 加密密钥
 * @param onProgress - 进度回调 (current, total, filePath)
 * @returns 修复统计
 */
export async function repairLocalEncryptedFiles(
	vault: Vault,
	encryptionKey: CryptoKey,
	onProgress?: (current: number, total: number, filePath: string) => void,
): Promise<{ success: number; failed: number; scanned: number }> {
	const allFiles = await walkLocalFiles(vault)
	let success = 0
	let failed = 0
	let scanned = 0

	for (let i = 0; i < allFiles.length; i++) {
		const filePath = allFiles[i]
		onProgress?.(i + 1, allFiles.length, filePath)

		try {
			const data = await vault.adapter.readBinary(filePath)
			const decrypted = await decrypt(data, encryptionKey)
			if (data.byteLength !== decrypted.byteLength) {
				await vault.adapter.writeBinary(filePath, decrypted)
				success++
			}
			scanned++
		} catch {
			failed++
		}
	}

	return { success, failed, scanned }
}

async function walkLocalFiles(vault: Vault, dir = ''): Promise<string[]> {
	const files: string[] = []
	const { folders, files: dirFiles } = await vault.adapter.list(dir)
	for (const file of dirFiles) {
		if (file.startsWith('.')) continue
		files.push(dir ? `${dir}/${file}` : file)
	}
	for (const folder of folders) {
		if (folder.startsWith('.')) continue
		const subDir = dir ? `${dir}/${folder}` : folder
		files.push(...(await walkLocalFiles(vault, subDir)))
	}
	return files
}
