import { describe, it, expect, vi } from 'vitest'
import {
	buildRemoteStatsFromRecords,
	computeRemoteFingerprint,
} from './remote-fingerprint'
import type { SyncRecordModel } from '~/model/sync-record.model'
import type { StatModel } from '~/model/stat.model'

function makeFileStat(path: string, mtime: number, size: number): StatModel {
	return {
		path,
		basename: path.split('/').pop()!,
		isDir: false,
		isDeleted: false,
		mtime,
		size,
	}
}

function makeDirStat(path: string): StatModel {
	return {
		path,
		basename: path.split('/').pop()!,
		isDir: true,
		isDeleted: false,
		mtime: 0,
	}
}

function makeRecord(remote: StatModel): SyncRecordModel {
	return {
		local: remote.isDir
			? { ...remote }
			: { ...remote, mtime: (remote as any).mtime + 1000 },
		remote,
	}
}

describe('buildRemoteStatsFromRecords', () => {
	it('returns empty array for empty records', () => {
		expect(buildRemoteStatsFromRecords(new Map())).toEqual([])
	})

	it('extracts file and directory remote stats from records', () => {
		const fileStat = makeFileStat('note.md', 1000000, 42)
		const dirStat = makeDirStat('folder')
		const records = new Map<string, SyncRecordModel>([
			['note.md', makeRecord(fileStat)],
			['folder', makeRecord(dirStat)],
		])

		const result = buildRemoteStatsFromRecords(records)
		expect(result).toHaveLength(2)
		expect(result).toContainEqual(fileStat)
		expect(result).toContainEqual(dirStat)
	})

	it('excludes deleted remote entries', () => {
		const liveStat = makeFileStat('live.md', 1000000, 10)
		const deletedStat: StatModel = {
			path: 'dead.md',
			basename: 'dead.md',
			isDir: false,
			isDeleted: true,
			mtime: 2000000,
			size: 20,
		}
		const records = new Map<string, SyncRecordModel>([
			['live.md', makeRecord(liveStat)],
			['dead.md', makeRecord(deletedStat)],
		])

		const result = buildRemoteStatsFromRecords(records)
		expect(result).toHaveLength(1)
		expect(result[0].path).toBe('live.md')
	})

	it('preserves nested directory paths', () => {
		const dirStat = makeDirStat('a/b/c')
		const records = new Map<string, SyncRecordModel>([
			['a/b/c', makeRecord(dirStat)],
		])

		const result = buildRemoteStatsFromRecords(records)
		expect(result).toHaveLength(1)
		expect(result[0].isDir).toBe(true)
		expect(result[0].path).toBe('a/b/c')
	})
})

// computeRemoteFingerprint tests — mock getDirectoryContents
vi.mock('~/api/webdav', () => ({
	getDirectoryContents: vi.fn(),
}))

describe('computeRemoteFingerprint', () => {
	it('returns a consistent string hash for same input', async () => {
		const { getDirectoryContents } = await import('~/api/webdav')
		;(getDirectoryContents as any).mockResolvedValue([
			{ filename: 'a.md', lastmod: 'Mon, 01 Jan 2024 00:00:00 GMT' },
			{ filename: 'b.md', lastmod: 'Tue, 02 Jan 2024 00:00:00 GMT' },
		])

		const fp1 = await computeRemoteFingerprint('t', 'https://x.com', '/v')
		const fp2 = await computeRemoteFingerprint('t', 'https://x.com', '/v')

		expect(fp1).toBe(fp2)
		expect(typeof fp1).toBe('string')
		expect(fp1.length).toBeGreaterThan(0)
	})

	it('returns different hash when file list changes', async () => {
		const { getDirectoryContents } = await import('~/api/webdav')
		;(getDirectoryContents as any).mockResolvedValueOnce([
			{ filename: 'a.md', lastmod: 'Mon, 01 Jan 2024 00:00:00 GMT' },
		])
		const fp1 = await computeRemoteFingerprint('t', 'https://x.com', '/v')

		;(getDirectoryContents as any).mockResolvedValueOnce([
			{ filename: 'a.md', lastmod: 'Mon, 01 Jan 2024 00:00:00 GMT' },
			{ filename: 'b.md', lastmod: 'Tue, 02 Jan 2024 00:00:00 GMT' },
		])
		const fp2 = await computeRemoteFingerprint('t', 'https://x.com', '/v')

		expect(fp1).not.toBe(fp2)
	})

	it('returns different hash when a file mtime changes', async () => {
		const { getDirectoryContents } = await import('~/api/webdav')
		;(getDirectoryContents as any).mockResolvedValueOnce([
			{ filename: 'a.md', lastmod: 'Mon, 01 Jan 2024 00:00:00 GMT' },
		])
		const fp1 = await computeRemoteFingerprint('t', 'https://x.com', '/v')

		;(getDirectoryContents as any).mockResolvedValueOnce([
			{ filename: 'a.md', lastmod: 'Wed, 03 Jan 2024 00:00:00 GMT' },
		])
		const fp2 = await computeRemoteFingerprint('t', 'https://x.com', '/v')

		expect(fp1).not.toBe(fp2)
	})

	it('handles empty directory', async () => {
		const { getDirectoryContents } = await import('~/api/webdav')
		;(getDirectoryContents as any).mockResolvedValue([])

		const fp = await computeRemoteFingerprint('t', 'https://x.com', '/empty')
		expect(typeof fp).toBe('string')
	})

	it('produces stable results regardless of API return order', async () => {
		const { getDirectoryContents } = await import('~/api/webdav')
		;(getDirectoryContents as any).mockResolvedValueOnce([
			{ filename: 'z.md', lastmod: 'Mon, 01 Jan 2024 00:00:00 GMT' },
			{ filename: 'a.md', lastmod: 'Mon, 01 Jan 2024 00:00:00 GMT' },
		])
		const fp1 = await computeRemoteFingerprint('t', 'https://x.com', '/v')

		;(getDirectoryContents as any).mockResolvedValueOnce([
			{ filename: 'a.md', lastmod: 'Mon, 01 Jan 2024 00:00:00 GMT' },
			{ filename: 'z.md', lastmod: 'Mon, 01 Jan 2024 00:00:00 GMT' },
		])
		const fp2 = await computeRemoteFingerprint('t', 'https://x.com', '/v')

		expect(fp1).toBe(fp2)
	})
})
