/**
 * 压缩模块
 *
 * 使用浏览器内置的 Compression Streams API (gzip/deflate)
 * 无需外部依赖
 */

/**
 * 压缩数据（gzip 格式）
 *
 * @param data - 原始 ArrayBuffer
 * @returns 压缩后的 ArrayBuffer
 */
export async function compressGzip(data: ArrayBuffer): Promise<ArrayBuffer> {
	const cs = new CompressionStream('gzip')
	const writer = cs.writable.getWriter()
	writer.write(data)
	writer.close()

	const chunks: Uint8Array[] = []
	const reader = cs.readable.getReader()

	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		chunks.push(value)
	}

	// 合并所有 chunk
	const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0)
	const result = new Uint8Array(totalLength)
	let offset = 0
	for (const chunk of chunks) {
		result.set(chunk, offset)
		offset += chunk.length
	}

	return result.buffer
}

/**
 * 解压数据（gzip 格式）
 *
 * @param data - 压缩的 ArrayBuffer
 * @returns 解压后的 ArrayBuffer
 */
export async function decompressGzip(data: ArrayBuffer): Promise<ArrayBuffer> {
	const cs = new DecompressionStream('gzip')
	const writer = cs.writable.getWriter()
	writer.write(data)
	writer.close()

	const chunks: Uint8Array[] = []
	const reader = cs.readable.getReader()

	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		chunks.push(value)
	}

	// 合并所有 chunk
	const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0)
	const result = new Uint8Array(totalLength)
	let offset = 0
	for (const chunk of chunks) {
		result.set(chunk, offset)
		offset += chunk.length
	}

	return result.buffer
}
