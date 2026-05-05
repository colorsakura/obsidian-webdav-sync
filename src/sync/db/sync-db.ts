import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'
import type { Vault } from 'obsidian'
import { sha256Hex } from '~/utils/sha256'
import GlobMatch, {
	needIncludeFromGlobRules,
	type GlobMatchOptions,
} from '~/utils/glob-match'
import wasmBase64 from './wasm-binary'

let _wasmBinary: ArrayBuffer | null = null

function getWasmBinary(): ArrayBuffer {
	if (!_wasmBinary) {
		const binaryStr = atob(wasmBase64)
		const bytes = new Uint8Array(binaryStr.length)
		for (let i = 0; i < binaryStr.length; i++) {
			bytes[i] = binaryStr.charCodeAt(i)
		}
		_wasmBinary = bytes.buffer
	}
	return _wasmBinary
}

async function getSql() {
	return initSqlJs({ wasmBinary: getWasmBinary() })
}

export interface DBFile {
	path: string
	mtime: number
	size: number
	hash: string
	isDir: number
	firstSeenAt: number
	contentChangedAt: number
	lastSyncedAt: number
}

export interface FilterRules {
	exclude: GlobMatchOptions[]
	include: GlobMatchOptions[]
}

export class SyncDB {
	private constructor(private sqlDb: SqlJsDatabase) {}

	static async fromVault(
		vault: Vault,
		filterRules: FilterRules,
		baseDB?: SyncDB,
	): Promise<SyncDB> {
		const sql = await getSql()
		const db = new sql.Database()
		SyncDB.initSchema(db)

		const deviceId = crypto.randomUUID()
		SyncDB.setMeta(db, 'device_id', deviceId)
		SyncDB.setMeta(db, 'version', '1')
		SyncDB.setMeta(db, 'created_at', String(Date.now()))

		const excludeGlobs: GlobMatch[] = filterRules.exclude.map(
			(p) => new GlobMatch(p.expr, p.options),
		)
		const includeGlobs: GlobMatch[] = filterRules.include.map(
			(p) => new GlobMatch(p.expr, p.options),
		)

		const isIncluded = (path: string): boolean => {
			return needIncludeFromGlobRules(path, includeGlobs, excludeGlobs)
		}

		const insertStmt = db.prepare(
			'INSERT OR REPLACE INTO files (path, mtime, size, hash, is_dir) VALUES (?, ?, ?, ?, ?)',
		)

		// BFS traversal to recursively discover all files and directories
		const queue: string[] = ['/']
		const allFolders = new Set<string>()

		while (queue.length > 0) {
			const currentDir = queue.shift()!
			const { files = [], folders = [] } = await vault.adapter.list(currentDir)

			// Process subdirectories
			for (const folder of folders) {
				const normalizedFolder = folder.replace(/\/$/, '')
				if (!isIncluded(normalizedFolder)) continue
				allFolders.add(normalizedFolder)
				// Ensure parent directories exist (defensive: upward collection)
				const parts = normalizedFolder.split('/')
				for (let i = 1; i < parts.length; i++) {
					const parentPath = parts.slice(0, i).join('/')
					if (!isIncluded(parentPath)) continue
					allFolders.add(parentPath)
				}
				queue.push(normalizedFolder)
			}

			// Process files
			for (const filePath of files) {
				if (!isIncluded(filePath)) continue
				const stat = await vault.adapter.stat(filePath)
				const mtime = stat?.mtime ?? 0
				const size = stat?.size ?? 0

				const baseFile = baseDB?.getFile(filePath)
				let hash: string
				if (baseFile && baseFile.mtime === mtime) {
					hash = baseFile.hash
				} else {
					const content = await vault.adapter.readBinary(filePath)
					hash = await sha256Hex(content)
				}

				insertStmt.run([filePath, mtime, size, hash, 0])
			}
		}

		// Insert all directories after collecting them
		for (const folder of allFolders) {
			insertStmt.run([folder, 0, 0, '', 1])
		}

		insertStmt.free()
		return new SyncDB(db)
	}

	static async fromBuffer(buffer: ArrayBuffer): Promise<SyncDB> {
		const sql = await getSql()
		try {
			const db = new sql.Database(new Uint8Array(buffer))
			db.exec('SELECT count(*) FROM sqlite_master')
			SyncDB.migrateIfNeeded(db)
			return new SyncDB(db)
		} catch (err) {
			throw new Error(
				'Failed to load SyncDB from buffer: invalid or corrupt SQLite data',
			)
		}
	}

	static async empty(deviceId: string): Promise<SyncDB> {
		const sql = await getSql()
		const db = new sql.Database()
		SyncDB.initSchema(db)
		SyncDB.setMeta(db, 'device_id', deviceId)
		SyncDB.setMeta(db, 'version', '1')
		SyncDB.setMeta(db, 'created_at', String(Date.now()))
		return new SyncDB(db)
	}

	toBuffer(): ArrayBuffer {
		return this.sqlDb.export().buffer as ArrayBuffer
	}

	getAllFiles(): DBFile[] {
		const results = this.sqlDb.exec(
			'SELECT path, mtime, size, hash, is_dir, first_seen_at, content_changed_at, last_synced_at FROM files',
		)
		if (results.length === 0) return []
		const { columns, values } = results[0]
		const pathIdx = columns.indexOf('path')
		const mtimeIdx = columns.indexOf('mtime')
		const sizeIdx = columns.indexOf('size')
		const hashIdx = columns.indexOf('hash')
		const isDirIdx = columns.indexOf('is_dir')
		const firstSeenIdx = columns.indexOf('first_seen_at')
		const contentChangedIdx = columns.indexOf('content_changed_at')
		const lastSyncedIdx = columns.indexOf('last_synced_at')
		return values.map((row) => ({
			path: row[pathIdx] as string,
			mtime: row[mtimeIdx] as number,
			size: row[sizeIdx] as number,
			hash: row[hashIdx] as string,
			isDir: row[isDirIdx] as number,
			firstSeenAt: (row[firstSeenIdx] as number) ?? 0,
			contentChangedAt: (row[contentChangedIdx] as number) ?? 0,
			lastSyncedAt: (row[lastSyncedIdx] as number) ?? 0,
		}))
	}

	getFile(path: string): DBFile | undefined {
		const stmt = this.sqlDb.prepare(
			'SELECT path, mtime, size, hash, is_dir, first_seen_at, content_changed_at, last_synced_at FROM files WHERE path = ?',
		)
		stmt.bind([path])
		if (stmt.step()) {
			const cols = stmt.getColumnNames()
			const vals = stmt.get()
			stmt.free()
			const v = (col: string) => vals[cols.indexOf(col)] as number | undefined
			return {
				path: vals[cols.indexOf('path')] as string,
				mtime: vals[cols.indexOf('mtime')] as number,
				size: vals[cols.indexOf('size')] as number,
				hash: vals[cols.indexOf('hash')] as string,
				isDir: vals[cols.indexOf('is_dir')] as number,
				firstSeenAt: v('first_seen_at') ?? 0,
				contentChangedAt: v('content_changed_at') ?? 0,
				lastSyncedAt: v('last_synced_at') ?? 0,
			}
		}
		stmt.free()
		return undefined
	}

	getAllPaths(): Set<string> {
		const results = this.sqlDb.exec('SELECT path FROM files')
		if (results.length === 0) return new Set()
		return new Set(results[0].values.map((row) => row[0] as string))
	}

	upsertFile(file: DBFile): void {
		this.sqlDb.run(
			'INSERT OR REPLACE INTO files (path, mtime, size, hash, is_dir, first_seen_at, content_changed_at, last_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
			[file.path, file.mtime, file.size, file.hash, file.isDir, file.firstSeenAt, file.contentChangedAt, file.lastSyncedAt],
		)
	}

	deleteFile(path: string): void {
		this.sqlDb.run('DELETE FROM files WHERE path = ?', [path])
	}

	getMeta(key: string): string | undefined {
		const stmt = this.sqlDb.prepare('SELECT value FROM meta WHERE key = ?')
		stmt.bind([key])
		if (stmt.step()) {
			const val = stmt.get()[0] as string
			stmt.free()
			return val
		}
		stmt.free()
		return undefined
	}

	setMeta(key: string, value: string): void {
		this.sqlDb.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
			key,
			value,
		])
	}

	get deviceId(): string {
		return this.getMeta('device_id') ?? ''
	}

	get version(): number {
		return parseInt(this.getMeta('version') ?? '1', 10)
	}

	private static initSchema(db: SqlJsDatabase): void {
		db.run(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        hash TEXT NOT NULL,
        is_dir INTEGER DEFAULT 0,
        first_seen_at INTEGER DEFAULT 0,
        content_changed_at INTEGER DEFAULT 0,
        last_synced_at INTEGER DEFAULT 0
      )
    `)
		db.run(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `)
		db.run(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        device_name TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL DEFAULT '',
        last_online_at INTEGER DEFAULT 0,
        first_seen_at INTEGER DEFAULT 0
      )
    `)
		db.run(`
      CREATE TABLE IF NOT EXISTS sync_sessions (
        session_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER DEFAULT 0,
        total_tasks INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        push_count INTEGER DEFAULT 0,
        pull_count INTEGER DEFAULT 0,
        remove_count INTEGER DEFAULT 0,
        conflict_count INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'completed',
        error_message TEXT DEFAULT ''
      )
    `)
	}

	private static migrateIfNeeded(db: SqlJsDatabase): void {
		// Check if files table has new columns
		const cols = db.exec('PRAGMA table_info(files)')
		if (cols.length > 0) {
			const columnNames = cols[0].values.map((r) => r[1] as string)
			if (!columnNames.includes('first_seen_at')) {
				db.run('ALTER TABLE files ADD COLUMN first_seen_at INTEGER DEFAULT 0')
			}
			if (!columnNames.includes('content_changed_at')) {
				db.run('ALTER TABLE files ADD COLUMN content_changed_at INTEGER DEFAULT 0')
			}
			if (!columnNames.includes('last_synced_at')) {
				db.run('ALTER TABLE files ADD COLUMN last_synced_at INTEGER DEFAULT 0')
			}
		}

		// Check and create devices table
		const deviceTable = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='devices'")
		if (deviceTable.length === 0 || deviceTable[0].values.length === 0) {
			db.run(`
				CREATE TABLE IF NOT EXISTS devices (
					device_id TEXT PRIMARY KEY,
					device_name TEXT NOT NULL DEFAULT '',
					platform TEXT NOT NULL DEFAULT '',
					last_online_at INTEGER DEFAULT 0,
					first_seen_at INTEGER DEFAULT 0
				)
			`)
		}

		// Check and create sync_sessions table
		const sessionsTable = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_sessions'")
		if (sessionsTable.length === 0 || sessionsTable[0].values.length === 0) {
			db.run(`
				CREATE TABLE IF NOT EXISTS sync_sessions (
					session_id TEXT PRIMARY KEY,
					device_id TEXT NOT NULL,
					started_at INTEGER NOT NULL,
					ended_at INTEGER DEFAULT 0,
					total_tasks INTEGER DEFAULT 0,
					success_count INTEGER DEFAULT 0,
					fail_count INTEGER DEFAULT 0,
					push_count INTEGER DEFAULT 0,
					pull_count INTEGER DEFAULT 0,
					remove_count INTEGER DEFAULT 0,
					conflict_count INTEGER DEFAULT 0,
					duration_ms INTEGER DEFAULT 0,
					status TEXT NOT NULL DEFAULT 'completed',
					error_message TEXT DEFAULT ''
				)
			`)
		}

		// Update version marker
		db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('version', '2')")
	}

	private static setMeta(db: SqlJsDatabase, key: string, value: string): void {
		db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
			key,
			value,
		])
	}
}
