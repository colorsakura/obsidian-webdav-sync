/**
 * 允许的 mtime 容差（毫秒）
 *
 * WebDAV 服务器的 PROPFIND 响应中 getlastmodified 只有秒级精度（RFC 1123 格式），
 * 而本地文件系统的 mtime 可能有毫秒甚至更高精度。
 * 另外不同文件系统/平台在 stat 调用中返回的精度也可能不一致。
 * 使用 2000ms 的容差可以有效避免因精度差异导致的误判"本地文件已修改"。
 */
const MTIME_TOLERANCE_MS = 2000

export function isSameTime(
	timestamp1: Date | number | undefined,
	timestamp2: Date | number | undefined,
): boolean {
	// If either timestamp is undefined, they are not the same
	if (timestamp1 === undefined || timestamp2 === undefined) {
		return false
	}

	const time1 =
		typeof timestamp1 === 'number' ? timestamp1 : timestamp1.getTime()
	const time2 =
		typeof timestamp2 === 'number' ? timestamp2 : timestamp2.getTime()

	return Math.abs(time1 - time2) <= MTIME_TOLERANCE_MS
}
