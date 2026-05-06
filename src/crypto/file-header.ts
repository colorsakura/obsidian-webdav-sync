/**
 * 加密文件 header 读写
 *
 * 每个加密文件的格式:
 * ┌──────────────────────────────────────┐
 * │  Header (明文，19 bytes)              │
 * │  ├── magic:     "OBSENC"  (6 bytes)  │  识别加密文件
 * │  ├── version:   0x01      (1 byte)   │  格式版本
 * │  └── nonce:     随机      (12 bytes)  │  AES-GCM IV
 * ├──────────────────────────────────────┤
 * │  Ciphertext + Auth Tag               │  AES-256-GCM 加密的原始内容
 * │  (原始文件大小 + 16 bytes tag)         │
 * └──────────────────────────────────────┘
 */

import type { FileHeader } from './types'

/** magic header 用于识别加密文件 */
const MAGIC = new TextEncoder().encode('OBSENC') // [79, 66, 83, 69, 78, 67]

/** header 版本号 */
const VERSION = 0x01

/** header 总大小: 6 (magic) + 1 (version) + 12 (nonce) = 19 */
export const HEADER_SIZE = 19

/** AES-GCM 认证标签大小 (固定 16 bytes) */
export const GCM_TAG_SIZE = 16

/** 加密总开销: header + GCM tag = 35 bytes */
export const ENCRYPTION_OVERHEAD = HEADER_SIZE + GCM_TAG_SIZE

/**
 * 判断数据是否以加密 header 开头
 */
export function isEncrypted(data: ArrayBuffer): boolean {
	if (data.byteLength < MAGIC.length) return false
	const header = new Uint8Array(data, 0, MAGIC.length)
	return header.every((b, i) => b === MAGIC[i])
}

/**
 * 打包 header: magic + version + nonce + ciphertext
 */
export function packHeader(
	nonce: Uint8Array,
	ciphertext: ArrayBuffer,
): ArrayBuffer {
	const header = new Uint8Array(HEADER_SIZE)
	header.set(MAGIC, 0)
	header[6] = VERSION
	header.set(nonce, 7)

	const result = new Uint8Array(HEADER_SIZE + ciphertext.byteLength)
	result.set(header, 0)
	result.set(new Uint8Array(ciphertext), HEADER_SIZE)
	return result.buffer
}

/**
 * 解包 header: 从加密数据中提取 nonce 和 ciphertext
 */
export function unpackHeader(wireData: ArrayBuffer): FileHeader {
	const nonce = new Uint8Array(wireData, 7, 12)
	const ciphertext = wireData.slice(HEADER_SIZE)
	return { nonce, ciphertext }
}
