/**
 * 加密模块单元测试
 *
 * 覆盖: 加解密、header、密钥派生、密钥存储
 */

import { describe, expect, it } from 'vitest'
import { encrypt, decrypt } from '~/crypto/cipher'
import { deriveKey } from '~/crypto/key-derivation'
import {
	isEncrypted,
	HEADER_SIZE,
	ENCRYPTION_OVERHEAD,
	packHeader,
	unpackHeader,
} from '~/crypto/file-header'
import { verifyPassword } from '~/crypto/key-store'

/**
 * 生成测试用的 AES-256-GCM 密钥（可导出）
 */
async function createTestKey(): Promise<CryptoKey> {
	const salt = crypto.getRandomValues(new Uint8Array(32))
	return deriveKey('test-password-123', salt)
}

/**
 * 生成可导出的测试密钥（用于验证 hash 等场景）
 */
async function createExtractableTestKey(
	password: string,
	salt: Uint8Array,
): Promise<{ key: CryptoKey; rawKey: Uint8Array }> {
	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveKey'],
	)
	const key = await crypto.subtle.deriveKey(
		{ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
		keyMaterial,
		{ name: 'AES-GCM', length: 256 },
		true, // extractable!
		['encrypt', 'decrypt'],
	)
	const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key))
	return { key, rawKey }
}

/**
 * 创建指定大小的随机 ArrayBuffer
 * crypto.getRandomValues 单次最多 65536 bytes，分块处理
 */
function randomBytes(size: number): ArrayBuffer {
	const buf = new Uint8Array(size)
	const chunkSize = 65536
	for (let i = 0; i < size; i += chunkSize) {
		const end = Math.min(i + chunkSize, size)
		crypto.getRandomValues(buf.subarray(i, end))
	}
	return buf.buffer
}

/**
 * 字符串转 ArrayBuffer
 */
function str2ab(str: string): ArrayBuffer {
	return new TextEncoder().encode(str).buffer
}

/**
 * ArrayBuffer 转字符串
 */
function ab2str(ab: ArrayBuffer): string {
	return new TextDecoder().decode(ab)
}

// ─── File Header ──────────────────────────────────────────────

describe('File Header', () => {
	it('packHeader creates valid encrypted file structure', () => {
		const nonce = crypto.getRandomValues(new Uint8Array(12))
		const ciphertext = randomBytes(100)
		const packed = packHeader(nonce, ciphertext)

		// Header size check
		expect(packed.byteLength).toBe(HEADER_SIZE + 100)

		// Magic bytes check
		const magic = new Uint8Array(packed, 0, 6)
		const expected = new TextEncoder().encode('OBSENC')
		expect([...magic]).toEqual([...expected])

		// Version check
		const version = new Uint8Array(packed, 6, 1)
		expect(version[0]).toBe(0x01)
	})

	it('unpackHeader correctly extracts nonce and ciphertext', () => {
		const nonce = crypto.getRandomValues(new Uint8Array(12))
		const ciphertext = randomBytes(50)
		const packed = packHeader(nonce, ciphertext)
		const unpacked = unpackHeader(packed)

		expect([...unpacked.nonce]).toEqual([...nonce])
		expect(unpacked.ciphertext.byteLength).toBe(50)
		expect(new Uint8Array(unpacked.ciphertext)).toEqual(
			new Uint8Array(ciphertext),
		)
	})

	it('isEncrypted detects OBSENC header', () => {
		const plainData = str2ab('hello world')
		expect(isEncrypted(plainData)).toBe(false)

		const nonce = crypto.getRandomValues(new Uint8Array(12))
		const encrypted = packHeader(nonce, randomBytes(10))
		expect(isEncrypted(encrypted)).toBe(true)
	})

	it('isEncrypted returns false for short data (< 6 bytes)', () => {
		expect(isEncrypted(new ArrayBuffer(3))).toBe(false)
		expect(isEncrypted(new ArrayBuffer(5))).toBe(false)
	})

	it('HEADER_SIZE is constant 19', () => {
		expect(HEADER_SIZE).toBe(19)
		// 6 magic + 1 version + 12 nonce
		expect(HEADER_SIZE).toBe(6 + 1 + 12)
	})
})

// ─── Encrypt / Decrypt ─────────────────────────────────────────

describe('Encrypt / Decrypt', () => {
	it('decrypts encrypted data back to original', async () => {
		const key = await createTestKey()
		const original = str2ab('Hello, Obsidian WebDAV Sync!')

		const encrypted = await encrypt(original, key)
		const decrypted = await decrypt(encrypted, key)

		expect(ab2str(decrypted)).toBe('Hello, Obsidian WebDAV Sync!')
	})

	it('encrypted size = original + ENCRYPTION_OVERHEAD (header + GCM tag)', async () => {
		const key = await createTestKey()
		const original = randomBytes(1024)
		const encrypted = await encrypt(original, key)
		expect(encrypted.byteLength).toBe(original.byteLength + ENCRYPTION_OVERHEAD)
	})

	it('passes through plaintext without encryption key', async () => {
		const key = await createTestKey()
		const plaintext = str2ab('plain data')

		// Decrypt should return same data for non-encrypted content
		const result = await decrypt(plaintext, key)
		expect(ab2str(result)).toBe('plain data')
	})

	it('each encryption produces different ciphertext (random nonce)', async () => {
		const key = await createTestKey()
		const data = str2ab('same data twice')

		const enc1 = await encrypt(data, key)
		const enc2 = await encrypt(data, key)

		// Same input should produce different output due to random nonce
		expect(new Uint8Array(enc1)).not.toEqual(new Uint8Array(enc2))

		// But both should decrypt to same result
		expect(ab2str(await decrypt(enc1, key))).toBe('same data twice')
		expect(ab2str(await decrypt(enc2, key))).toBe('same data twice')
	})

	it('handles empty file', async () => {
		const key = await createTestKey()
		const empty = new ArrayBuffer(0)

		const encrypted = await encrypt(empty, key)
		// Empty file + GCM tag(16) = 16, plus header
		expect(encrypted.byteLength).toBe(ENCRYPTION_OVERHEAD)

		const decrypted = await decrypt(encrypted, key)
		expect(decrypted.byteLength).toBe(0)
	})

	it('handles 1-byte file', async () => {
		const key = await createTestKey()
		const original = randomBytes(1)
		const encrypted = await encrypt(original, key)
		expect(encrypted.byteLength).toBe(1 + ENCRYPTION_OVERHEAD)

		const decrypted = await decrypt(encrypted, key)
		expect(decrypted.byteLength).toBe(1)
		expect(new Uint8Array(decrypted)).toEqual(new Uint8Array(original))
	})

	it('handles 1MB file', async () => {
		const key = await createTestKey()
		const original = randomBytes(1024 * 1024) // 1 MB
		const encrypted = await encrypt(original, key)
		expect(encrypted.byteLength).toBe(original.byteLength + ENCRYPTION_OVERHEAD)

		const decrypted = await decrypt(encrypted, key)
		expect(decrypted.byteLength).toBe(original.byteLength)
		expect(new Uint8Array(decrypted)).toEqual(new Uint8Array(original))
	}, 10000) // 10s timeout

	it('handles binary (non-UTF8) data correctly', async () => {
		const key = await createTestKey()
		// All possible byte values
		const original = new Uint8Array(256)
		for (let i = 0; i < 256; i++) {
			original[i] = i
		}

		const encrypted = await encrypt(original.buffer, key)
		const decrypted = await decrypt(encrypted, key)

		expect(new Uint8Array(decrypted)).toEqual(original)
	})

	it('throws/returns error on tampered ciphertext', async () => {
		const key = await createTestKey()
		const original = str2ab('important data')
		const encrypted = await encrypt(original, key)

		// Tamper with the ciphertext
		const tampered = new Uint8Array(encrypted)
		tampered[HEADER_SIZE + 2] ^= 0xff // flip a bit in ciphertext

		await expect(decrypt(tampered.buffer, key)).rejects.toThrow()
	})

	it('detects header tampering (magic bytes modified)', async () => {
		const key = await createTestKey()
		const original = str2ab('data')
		const encrypted = await encrypt(original, key)

		// Modify magic bytes → should be treated as plaintext
		const tampered = new Uint8Array(encrypted)
		tampered[0] = 0x00
		tampered[1] = 0x00

		// decrypt returns raw data if header doesn't match
		const result = await decrypt(tampered.buffer, key)
		// It should return the (now-invalid) data as-is since it's treated as plaintext
		expect(result.byteLength).toBe(encrypted.byteLength)
	})

	it('different keys produce incompatible ciphertexts', async () => {
		const key1 = await deriveKey('password1', new Uint8Array(32).fill(1))
		const key2 = await deriveKey('password2', new Uint8Array(32).fill(2))
		const original = str2ab('secret')

		const encrypted = await encrypt(original, key1)
		// Decrypting with wrong key should fail (GCM tag mismatch)
		await expect(decrypt(encrypted, key2)).rejects.toThrow()
	})

	it('check multiple files with different sizes', async () => {
		const key = await createTestKey()
		const sizes = [0, 1, 10, 100, 1000, 10000]

		for (const size of sizes) {
			const original = randomBytes(size)
			const encrypted = await encrypt(original, key)
			const decrypted = await decrypt(encrypted, key)

			expect(decrypted.byteLength).toBe(size)
			expect(new Uint8Array(decrypted)).toEqual(new Uint8Array(original))
		}
	})
})

// ─── Key Derivation ────────────────────────────────────────────

describe('Key Derivation', () => {
	it('derives a CryptoKey from password and salt', async () => {
		const salt = crypto.getRandomValues(new Uint8Array(32))
		const key = await deriveKey('mySecurePassword', salt)

		expect(key).toBeDefined()
		expect(key.type).toBe('secret')
		expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
		expect(key.usages).toContain('encrypt')
		expect(key.usages).toContain('decrypt')
	})

	it('same password + same salt → same key (deterministic)', async () => {
		const salt = crypto.getRandomValues(new Uint8Array(32))
		const password = 'deterministic-test'

		const key1 = await deriveKey(password, salt)
		const key2 = await deriveKey(password, salt)

		// Both keys should produce same encryption output
		const data = str2ab('test')
		const enc1 = await encrypt(data, key1)
		const enc2 = await encrypt(data, key2)

		// Different nonces → different ciphertext, but both decryptable
		await decrypt(enc1, key1)
		await decrypt(enc2, key2)
		await decrypt(enc1, key2)
		await decrypt(enc2, key1)
	})

	it('different passwords produce incompatible keys', async () => {
		const salt = crypto.getRandomValues(new Uint8Array(32))
		const key1 = await deriveKey('password1', salt)
		const key2 = await deriveKey('password2', salt)

		const data = str2ab('secret')
		const encrypted = await encrypt(data, key1)

		await expect(decrypt(encrypted, key2)).rejects.toThrow()
	})

	it('different salts with same password produce different keys', async () => {
		const password = 'same-password'
		const salt1 = crypto.getRandomValues(new Uint8Array(32))
		const salt2 = crypto.getRandomValues(new Uint8Array(32))
		// Ensure salts are different
		salt2[0] = salt1[0] ^ 0xff

		const key1 = await deriveKey(password, salt1)
		const key2 = await deriveKey(password, salt2)

		const data = str2ab('test')
		const encrypted = await encrypt(data, key1)

		await expect(decrypt(encrypted, key2)).rejects.toThrow()
	})
})

// ─── Password Verification ─────────────────────────────────────

describe('Password Verification', () => {
	it('verifyPassword returns true for correct password', async () => {
		const password = 'correct-password'
		const salt = crypto.getRandomValues(new Uint8Array(32))
		const { rawKey } = await createExtractableTestKey(password, salt)
		const hash = await crypto.subtle.digest('SHA-256', rawKey as BufferSource)
		const keyHash = Array.from(new Uint8Array(hash))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')

		const saltBase64 = btoa(String.fromCharCode(...salt))

		const valid = await verifyPassword(password, saltBase64, keyHash)
		expect(valid).toBe(true)
	})

	it('verifyPassword returns false for wrong password', async () => {
		const salt = crypto.getRandomValues(new Uint8Array(32))
		const { rawKey } = await createExtractableTestKey('right-password', salt)
		const hash = await crypto.subtle.digest('SHA-256', rawKey as BufferSource)
		const keyHash = Array.from(new Uint8Array(hash))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')

		const saltBase64 = btoa(String.fromCharCode(...salt))

		const valid = await verifyPassword('wrong-password', saltBase64, keyHash)
		expect(valid).toBe(false)
	})
})

// ─── End-to-End: Simulated Sync Flow ───────────────────────────

describe('End-to-End Sync Flow', () => {
	it('simulates push → pull roundtrip with encryption', async () => {
		const key = await createTestKey()

		// Step 1: Local file content (plaintext)
		const localContent = str2ab('# My Note\n\nHello World!')

		// Step 2: PushTask encrypts before upload
		const encryptedForUpload = await encrypt(localContent, key)
		expect(isEncrypted(encryptedForUpload)).toBe(true)

		// Step 3: "Upload" to WebDAV (simulated — content is encrypted)
		const storedOnRemote = encryptedForUpload

		// Step 4: PullTask decrypts after download
		const downloadedFromRemote = storedOnRemote
		const decryptedContent = await decrypt(downloadedFromRemote, key)

		// Step 5: Verify local content matches decrypted content
		expect(ab2str(decryptedContent)).toBe('# My Note\n\nHello World!')
		expect(decryptedContent.byteLength).toBe(localContent.byteLength)
	})

	it('handles plaintext + encrypted mixed state (forward compat)', async () => {
		const key = await createTestKey()

		// Plaintext file (old, unencrypted)
		const plainFile = str2ab('plain old file')
		expect(isEncrypted(plainFile)).toBe(false)

		// Encrypted file (new)
		const encryptedFile = await encrypt(str2ab('new encrypted file'), key)
		expect(isEncrypted(encryptedFile)).toBe(true)

		// Both go through decrypt
		const decPlain = await decrypt(plainFile, key)
		const decEnc = await decrypt(encryptedFile, key)

		expect(ab2str(decPlain)).toBe('plain old file')
		expect(ab2str(decEnc)).toBe('new encrypted file')
	})

	it('ConflictResolve: merge two encrypted versions', async () => {
		const key = await createTestKey()

		// Simulate:
		// User A edits locally → encrypts → uploads
		// User B also edits → we download User A's encrypted version
		// We need to decrypt both, merge, then encrypt result

		const localPlaintext = str2ab('version A: line 1\nline 2')
		const remoteEncrypted = await encrypt(
			str2ab('version B: line 1\nline 2 edited'),
			key,
		)

		// Decrypt remote for merging
		const remotePlaintext = await decrypt(remoteEncrypted, key)

		// Simple merge (take remote in this case)
		const mergedPlaintext = remotePlaintext

		// Encrypt merged result for upload
		const mergedEncrypted = await encrypt(mergedPlaintext, key)
		expect(isEncrypted(mergedEncrypted)).toBe(true)

		// Verify final
		const final = await decrypt(mergedEncrypted, key)
		expect(ab2str(final)).toBe('version B: line 1\nline 2 edited')
	})

	it('large file roundtrip preserves exact content', async () => {
		const key = await createTestKey()
		const size = 256 * 1024 // 256 KB
		const original = randomBytes(size)

		const encrypted = await encrypt(original, key)
		const decrypted = await decrypt(encrypted, key)

		expect(decrypted.byteLength).toBe(size)
		expect(new Uint8Array(decrypted)).toEqual(new Uint8Array(original))
	}, 15000)

	it('multiple roundtrips with same key produce stable results', async () => {
		const key = await createTestKey()
		const original = str2ab('stable content test')

		for (let i = 0; i < 5; i++) {
			const encrypted = await encrypt(original, key)
			const decrypted = await decrypt(encrypted, key)
			expect(ab2str(decrypted)).toBe('stable content test')
		}
	})

	it('LOOSE mode: encrypted remote size correctly matches local size after subtracting overhead', async () => {
		const key = await createTestKey()
		const localContent = str2ab('test content for loose mode')
		const encrypted = await encrypt(localContent, key)

		// Verify: encrypted size - ENCRYPTION_OVERHEAD === local size
		expect(encrypted.byteLength - ENCRYPTION_OVERHEAD).toBe(
			localContent.byteLength,
		)

		// This is what isSameSizeInLooseMode should do
		const localSize = localContent.byteLength
		const remoteSize = encrypted.byteLength
		const matched = remoteSize - ENCRYPTION_OVERHEAD === localSize
		expect(matched).toBe(true)
	})
})

// ─── Cross-Platform Iteration Compatibility ─────────────────────

describe('Cross-Platform Iteration Compatibility', () => {
	it('verifyPassword works cross-platform with explicit iterations', async () => {
		const password = 'cross-platform-password'
		const salt = crypto.getRandomValues(new Uint8Array(32))
		const saltBase64 = btoa(String.fromCharCode(...salt))

		// 模拟桌面端 (600K 迭代) 创建
		const keyDesktop = await deriveKey(password, salt, 600_000)
		const rawKeyDesktop = new Uint8Array(
			await crypto.subtle.exportKey('raw', keyDesktop),
		)
		const hashDesktop = await crypto.subtle.digest(
			'SHA-256',
			rawKeyDesktop as BufferSource,
		)
		const keyHashDesktop = Array.from(new Uint8Array(hashDesktop))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')

		// 传入正确迭代次数 → 应成功
		const valid = await verifyPassword(
			password,
			saltBase64,
			keyHashDesktop,
			600_000,
		)
		expect(valid).toBe(true)

		// 传入错误迭代次数 → 应失败
		const invalid = await verifyPassword(
			password,
			saltBase64,
			keyHashDesktop,
			100_000,
		)
		expect(invalid).toBe(false)
	})

	it('verifyPassword backward compat: auto-detects iterations when not stored', async () => {
		const password = 'backward-compat-test'
		const salt = crypto.getRandomValues(new Uint8Array(32))
		const saltBase64 = btoa(String.fromCharCode(...salt))

		// 模拟桌面端创建 (600K)
		const { rawKey } = await createExtractableTestKey(password, salt)
		const hash = await crypto.subtle.digest('SHA-256', rawKey as BufferSource)
		const keyHash = Array.from(new Uint8Array(hash))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')

		// 不传 iterations → 自动尝试 600K 和 100K → 600K 命中
		const valid = await verifyPassword(password, saltBase64, keyHash)
		expect(valid).toBe(true)
	})

	it('different iterations produce different keys from same password+salt', async () => {
		const password = 'same-everything'
		const salt = crypto.getRandomValues(new Uint8Array(32))

		const key600k = await deriveKey(password, salt, 600_000)
		const key100k = await deriveKey(password, salt, 100_000)

		// 用两个密钥分别加密
		const data = str2ab('test-cross-iteration')
		const encrypted600k = await encrypt(data, key600k)
		const encrypted100k = await encrypt(data, key100k)

		// 交叉解密应失败（不同迭代次数产生不同密钥）
		await expect(decrypt(encrypted600k, key100k)).rejects.toThrow()
		await expect(decrypt(encrypted100k, key600k)).rejects.toThrow()
	})
})
