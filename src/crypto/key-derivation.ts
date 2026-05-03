/**
 * PBKDF2 密钥派生
 *
 * 从用户密码 + salt 派生 AES-256 密钥
 */

import { Platform } from 'obsidian'

/**
 * 根据平台选择 PBKDF2 迭代次数
 * 移动端降低迭代数以减少密码输入等待时间
 */
export const DEFAULT_ITERATIONS = Platform.isMobileApp ? 100_000 : 600_000

/**
 * 从密码和 salt 派生 AES-256-GCM 密钥
 *
 * @param password - 用户输入的密码
 * @param salt - 随机 salt (至少 16 bytes，推荐 32 bytes)
 * @param iterations - PBKDF2 迭代次数，默认使用当前平台的 DEFAULT_ITERATIONS
 * @returns 可用于 AES-GCM 加密的 CryptoKey
 */
export async function deriveKey(
	password: string,
	salt: Uint8Array,
	iterations: number = DEFAULT_ITERATIONS,
): Promise<CryptoKey> {
	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveKey'],
	)

	return crypto.subtle.deriveKey(
		{
			name: 'PBKDF2',
			salt: salt as BufferSource,
			iterations,
			hash: 'SHA-256',
		},
		keyMaterial,
		{ name: 'AES-GCM', length: 256 },
		true,
		['encrypt', 'decrypt'],
	)
}

/**
 * 获取当前平台使用的 PBKDF2 迭代次数
 */
export function getPBKDF2Iterations(): number {
	return DEFAULT_ITERATIONS
}
