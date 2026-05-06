/**
 * AES-256-GCM 加解密实现
 *
 * 全部使用浏览器内置 crypto.subtle (Web Crypto API)，零外部依赖
 */

import { packHeader, unpackHeader } from './file-header'
import { compressGzip, decompressGzip } from './compression'

/**
 * 加密并可选压缩二进制数据
 *
 * @param plaintext - 原始明文 ArrayBuffer
 * @param key - AES-256-GCM CryptoKey
 * @param enableCompression - 是否先压缩再加密（仅在加密启用时有效）
 * @returns 带 header 的密文 ArrayBuffer
 */
export async function encrypt(
	plaintext: ArrayBuffer,
	key: CryptoKey,
	enableCompression: boolean = false,
): Promise<ArrayBuffer> {
	// 先压缩（仅当启用压缩且加密时才进行）
	let dataToEncrypt = plaintext
	let compressed = false
	if (enableCompression) {
		const compressedData = await compressGzip(plaintext)
		// 仅当压缩后更小时使用压缩
		if (compressedData.byteLength < plaintext.byteLength) {
			dataToEncrypt = compressedData
			compressed = true
		}
	}

	const nonce = crypto.getRandomValues(new Uint8Array(12))
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: nonce as BufferSource },
		key,
		dataToEncrypt,
	)
	return packHeader(nonce, ciphertext, compressed)
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
	const { nonce, ciphertext, compressed } = unpackHeader(wireData)

	const plaintext = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: nonce as BufferSource },
		key,
		ciphertext,
	)

	// 如果标记为压缩，则解压
	if (compressed) {
		return decompressGzip(plaintext)
	}

	return plaintext
}
