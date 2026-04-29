/**
 * 密钥存储 — Obsidian SecretStorage 集成
 *
 * 密钥生命周期:
 * 1. 首次设置 → 输入密码 → PBKDF2 派生 key → SecretStorage + data.json
 * 2. 每次同步 → SecretStorage 读取 hexKey → 导入 CryptoKey → 加解密
 * 3. 修改密码 → 验证旧密码 → 派生新 key → 更新 SecretStorage
 * 4. 忘记密码 → 无法恢复（远端文件永久不可解密）
 */

import { App } from 'obsidian'
import { fromUint8Array, toUint8Array } from 'js-base64'
import { deriveKey } from './key-derivation'
import type { EncryptionSettings } from './types'

/** SecretStorage 中存储密钥的 ID */
export const SECRET_ID = 'nutstore-encryption-key'

/**
 * 将 Uint8Array 转为 hex 字符串
 */
function buf2hex(buffer: Uint8Array): string {
	return Array.from(buffer)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
}

/**
 * 将 hex 字符串转为 Uint8Array
 */
function hex2buf(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2)
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
	}
	return bytes
}

/**
 * 首次设置加密
 *
 * 流程:
 * 1. 生成随机 salt (32 bytes)
 * 2. PBKDF2 派生 AES-256 key
 * 3. 导出 raw key → hex → 存入 SecretStorage
 * 4. 计算 keyHash → 存入 settings.encryption
 *
 * @param app - Obsidian App 实例
 * @param password - 用户输入的密码
 * @param encryption - 可变的 encryption settings 对象
 */
export async function setupEncryption(
	app: App,
	password: string,
	encryption: EncryptionSettings,
): Promise<void> {
	// 1. 生成随机 salt
	const salt = crypto.getRandomValues(new Uint8Array(32))

	// 2. 派生密钥
	const key = await deriveKey(password, salt)
	const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key))
	const hexKey = buf2hex(rawKey)

	// 3. 存入 SecretStorage
	await app.secretStorage.setSecret(SECRET_ID, hexKey)

	// 4. 计算 keyHash
	const hash = await crypto.subtle.digest('SHA-256', rawKey as BufferSource)

	// 5. 更新 encryption settings
	encryption.enabled = true
	encryption.secretId = SECRET_ID
	encryption.salt = fromUint8Array(salt, true)
	encryption.keyHash = buf2hex(new Uint8Array(hash))
}

/**
 * 加载加密密钥
 *
 * 流程:
 * 1. 从 SecretStorage 读取 hex key
 * 2. 验证 hash 是否匹配
 * 3. 导入 CryptoKey 并返回
 *
 * @param app - Obsidian App 实例
 * @param encryption - encryption settings 对象
 * @returns AES-GCM CryptoKey，如果加载失败返回 null
 */
export async function loadEncryptionKey(
	app: App,
	encryption: EncryptionSettings,
): Promise<CryptoKey | null> {
	if (!encryption.enabled) return null

	try {
		const hexKey = await app.secretStorage.getSecret(encryption.secretId)
		if (!hexKey) return null

		const rawKey = hex2buf(hexKey)

		// 验证 hash
		const hash = await crypto.subtle.digest('SHA-256', rawKey as BufferSource)
		if (buf2hex(new Uint8Array(hash)) !== encryption.keyHash) {
			console.error('[obsidian-webdav-sync] encryption key hash mismatch')
			return null
		}

		// 导入 CryptoKey
		return crypto.subtle.importKey(
			'raw',
			rawKey as BufferSource,
			'AES-GCM',
			false,
			['encrypt', 'decrypt'],
		)
	} catch (e) {
		console.error('[obsidian-webdav-sync] failed to load encryption key:', e)
		return null
	}
}

/**
 * 验证密码是否正确
 *
 * @param password - 待验证的密码
 * @param saltBase64 - base64 编码的 salt
 * @param expectedKeyHash - 期望的 keyHash (hex)
 * @returns true 表示密码正确
 */
export async function verifyPassword(
	password: string,
	saltBase64: string,
	expectedKeyHash: string,
): Promise<boolean> {
	try {
		const salt = toUint8Array(saltBase64)
		const key = await deriveKey(password, salt)
		const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key))
		const hash = await crypto.subtle.digest('SHA-256', rawKey as BufferSource)
		return buf2hex(new Uint8Array(hash)) === expectedKeyHash
	} catch {
		return false
	}
}

/**
 * 从密码恢复加密密钥
 *
 * 用于新设备场景：settings 中有 salt + keyHash，
 * 但 SecretStorage 中没有密钥。用户输入密码后重新派生
 * 密钥并存入 SecretStorage，不改变 salt。
 *
 * @param app - Obsidian App 实例
 * @param password - 用户输入的密码
 * @param encryption - 已有的 encryption settings（含 salt 和 keyHash）
 * @returns true 表示恢复成功，false 表示密码错误
 */
export async function restoreEncryption(
	app: App,
	password: string,
	encryption: EncryptionSettings,
): Promise<boolean> {
	const salt = toUint8Array(encryption.salt)
	const key = await deriveKey(password, salt)
	const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key))

	const hash = await crypto.subtle.digest('SHA-256', rawKey as BufferSource)
	if (buf2hex(new Uint8Array(hash)) !== encryption.keyHash) {
		return false
	}

	const hexKey = buf2hex(rawKey)
	await app.secretStorage.setSecret(SECRET_ID, hexKey)
	return true
}
