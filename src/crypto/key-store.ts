/**
 * 密钥存储 — Obsidian SecretStorage 集成
 *
 * 密钥生命周期:
 * 1. 首次设置 → 输入密码 → PBKDF2 派生 key → SecretStorage + data.json
 * 2. 每次同步 → SecretStorage 读取 hexKey → 导入 CryptoKey → 加解密
 * 3. 修改密码 → 验证旧密码 → 派生新 key → 更新 SecretStorage
 * 4. 忘记密码 → 无法恢复（远端文件永久不可解密）
 */

import type { App } from 'obsidian'
import { fromUint8Array, toUint8Array } from 'js-base64'
import {
	deriveKey,
	getPBKDF2Iterations,
	DEFAULT_ITERATIONS,
} from './key-derivation'
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
 * 派生密钥并计算 hash
 */
async function deriveAndHash(
	password: string,
	salt: Uint8Array,
	iterations: number,
): Promise<{ rawKey: Uint8Array; hexKey: string; hash: string }> {
	const key = await deriveKey(password, salt, iterations)
	const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key))
	const hexKey = buf2hex(rawKey)
	const hashBuffer = await crypto.subtle.digest(
		'SHA-256',
		rawKey as BufferSource,
	)
	const hash = buf2hex(new Uint8Array(hashBuffer))
	return { rawKey, hexKey, hash }
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
	const salt = crypto.getRandomValues(new Uint8Array(32))
	const iterations = getPBKDF2Iterations()

	const { hexKey, hash } = await deriveAndHash(password, salt, iterations)

	await app.secretStorage.setSecret(SECRET_ID, hexKey)

	encryption.enabled = true
	encryption.secretId = SECRET_ID
	encryption.salt = fromUint8Array(salt, true)
	encryption.keyHash = hash
	encryption.iterations = iterations
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
 * 尝试验证密码是否匹配
 *
 * 用指定的迭代次数派生密钥并比对 hash。
 */
async function tryVerify(
	password: string,
	salt: Uint8Array,
	expectedHash: string,
	iterations: number,
): Promise<boolean> {
	try {
		const { hash } = await deriveAndHash(password, salt, iterations)
		return hash === expectedHash
	} catch {
		return false
	}
}

/** 可能的 PBKDF2 迭代次数（桌面 600K，移动 100K） */
const ALL_POSSIBLE_ITERATIONS = [600_000, 100_000]

/**
 * 验证密码是否正确
 *
 * 使用存储的迭代次数；若未存储（旧版配置），尝试所有可能的迭代次数。
 *
 * @param password - 待验证的密码
 * @param saltBase64 - base64 编码的 salt
 * @param expectedKeyHash - 期望的 keyHash (hex)
 * @param iterations - PBKDF2 迭代次数（可选，未提供时尝试所有可能值）
 * @returns true 表示密码正确
 */
export async function verifyPassword(
	password: string,
	saltBase64: string,
	expectedKeyHash: string,
	iterations?: number,
): Promise<boolean> {
	const salt = toUint8Array(saltBase64)

	if (iterations && iterations > 0) {
		return tryVerify(password, salt, expectedKeyHash, iterations)
	}

	// 旧版配置未存储迭代次数：尝试所有可能值
	for (const it of ALL_POSSIBLE_ITERATIONS) {
		if (await tryVerify(password, salt, expectedKeyHash, it)) {
			return true
		}
	}
	return false
}

/**
 * 从密码恢复加密密钥
 *
 * 用于新设备场景：settings 中有 salt + keyHash，
 * 但 SecretStorage 中没有密钥。用户输入密码后重新派生
 * 密钥并存入 SecretStorage，不改变 salt。
 *
 * 使用存储的迭代次数确保跨平台兼容；旧版配置自动回退尝试所有可能值。
 *
 * @param app - Obsidian App 实例
 * @param password - 用户输入的密码
 * @param encryption - 已有的 encryption settings（含 salt、keyHash、iterations）
 * @returns true 表示恢复成功，false 表示密码错误
 */
export async function restoreEncryption(
	app: App,
	password: string,
	encryption: EncryptionSettings,
): Promise<boolean> {
	const salt = toUint8Array(encryption.salt)
	const storedIterations = encryption.iterations

	let matchedIterations: number | null = null

	if (storedIterations && storedIterations > 0) {
		if (await tryVerify(password, salt, encryption.keyHash, storedIterations)) {
			matchedIterations = storedIterations
		}
	} else {
		// 旧版配置未存储迭代次数：尝试所有可能值
		for (const it of ALL_POSSIBLE_ITERATIONS) {
			if (await tryVerify(password, salt, encryption.keyHash, it)) {
				matchedIterations = it
				break
			}
		}
	}

	if (matchedIterations === null) return false

	const { hexKey } = await deriveAndHash(password, salt, matchedIterations)
	await app.secretStorage.setSecret(SECRET_ID, hexKey)

	// 补齐迭代次数到配置中，后续不再需要重试
	if (!encryption.iterations) {
		encryption.iterations = matchedIterations
	}

	return true
}
