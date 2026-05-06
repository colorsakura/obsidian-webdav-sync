/**
 * 加密文件 header 读写
 *
 * 每个加密文件的格式:
 * ┌──────────────────────────────────────┐
 * │  Header (明文，20 bytes)              │
 * │  ├── magic:     "OBSENC"  (6 bytes)  │  识别加密文件
 * │  ├── version:   0x02      (1 byte)   │  格式版本 (v2: 压缩支持)
 * │  ├── flags:     1 byte              │  bit0: 压缩标志
 * │  └── nonce:     随机      (12 bytes)  │  AES-GCM IV
 * ├──────────────────────────────────────┤
 * │  Ciphertext + Auth Tag               │  AES-256-GCM 加密的原始内容
 * │  (原始文件大小 + 16 bytes tag)         │
 * └──────────────────────────────────────┘
 */

import type { FileHeader } from './types'

/** magic header 用于识别加密文件 */
const MAGIC = new TextEncoder().encode('OBSENC') // [79, 66, 83, 69, 78, 67]

/** header 版本号 (v2: 支持压缩) */
export const VERSION = 0x02

/** header 标志位偏移 */
const FLAGS_OFFSET = 6

/** nonce 偏移量 (magic=6 + version=1 + flags=1) */
const NONCE_OFFSET = 7

/** header 总大小: 6 (magic) + 1 (version) + 1 (flags) + 12 (nonce) = 20 */
export const HEADER_SIZE = 20

/** AES-GCM 认证标签大小 (固定 16 bytes) */
export const GCM_TAG_SIZE = 16

/** 加密总开销: header + GCM tag = 35 bytes */
export const ENCRYPTION_OVERHEAD = HEADER_SIZE + GCM_TAG_SIZE

/**
 * 判断数据是否以加密 header 开头
 */
/** 压缩标志位掩码 */
export const FLAG_COMPRESSED = 0x01

export function isEncrypted(data: ArrayBuffer): boolean {
	if (data.byteLength < MAGIC.length) return false
	const header = new Uint8Array(data, 0, MAGIC.length)
	return header.every((b, i) => b === MAGIC[i])
}

/**
 * 检查数据是否被压缩
 */
export function isCompressed(data: ArrayBuffer): boolean {
	if (!isEncrypted(data)) return false
	const view = new DataView(data)
	return (view.getUint8(FLAGS_OFFSET) & FLAG_COMPRESSED) !== 0
}

/**
 * 打包 header: magic + version + flags + nonce + ciphertext
 */
export function packHeader(
	nonce: Uint8Array,
	ciphertext: ArrayBuffer,
	compressed: boolean = false,
): ArrayBuffer {
	const header = new Uint8Array(HEADER_SIZE)
	header.set(MAGIC, 0)
	header[FLAGS_OFFSET] = VERSION
	header[FLAGS_OFFSET] = compressed ? FLAG_COMPRESSED : 0x00
	header.set(nonce, NONCE_OFFSET)

	const result = new Uint8Array(HEADER_SIZE + ciphertext.byteLength)
	result.set(header, 0)
	result.set(new Uint8Array(ciphertext), HEADER_SIZE)
	return result.buffer
}

/**
 * 解包 header: 从加密数据中提取 nonce、ciphertext 和压缩标志
 */
export function unpackHeader(wireData: ArrayBuffer): FileHeader {
	const flags = new Uint8Array(wireData, FLAGS_OFFSET, 1)[0]
	const nonce = new Uint8Array(wireData, NONCE_OFFSET, 12)
	const ciphertext = wireData.slice(HEADER_SIZE)
	return {
		nonce,
		ciphertext,
		compressed: (flags & FLAG_COMPRESSED) !== 0,
	}
}
