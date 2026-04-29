/**
 * AES-256-GCM 加解密实现
 *
 * 全部使用浏览器内置 crypto.subtle (Web Crypto API)，零外部依赖
 */

import { isEncrypted, packHeader, unpackHeader } from './file-header'

/**
 * 加密二进制数据
 *
 * @param plaintext - 原始明文 ArrayBuffer
 * @param key - AES-256-GCM CryptoKey
 * @returns 带 header 的密文 ArrayBuffer
 */
export async function encrypt(
	plaintext: ArrayBuffer,
	key: CryptoKey,
): Promise<ArrayBuffer> {
	const nonce = crypto.getRandomValues(new Uint8Array(12))
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: nonce as BufferSource },
		key,
		plaintext,
	)
	return packHeader(nonce, ciphertext)
}

/**
 * 解密二进制数据
 *
 * 如果数据不以 OBSENC header 开头，视为明文直接返回（向前兼容）
 *
 * @param wireData - 从远端读取的原始数据
 * @param key - AES-256-GCM CryptoKey
 * @returns 明文 ArrayBuffer
 */
export async function decrypt(
	wireData: ArrayBuffer,
	key: CryptoKey,
): Promise<ArrayBuffer> {
	// 明文文件，兼容旧数据
	if (!isEncrypted(wireData)) {
		return wireData
	}

	const { nonce, ciphertext } = unpackHeader(wireData)
	return crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: nonce as BufferSource },
		key,
		ciphertext,
	)
}
