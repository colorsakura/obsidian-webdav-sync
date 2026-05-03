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
	isDir: number // SQLite 用 0/1
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
				const content = await vault.adapter.readBinary(filePath)
				const stat = await vault.adapter.stat(filePath)
				const hash = await sha256Hex(content)
				insertStmt.run([filePath, stat?.mtime ?? 0, stat?.size ?? 0, hash, 0])
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
			// Validate that the buffer contains a valid SQLite database
			db.exec('SELECT count(*) FROM sqlite_master')
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
			'SELECT path, mtime, size, hash, is_dir FROM files',
		)
		if (results.length === 0) return []
		const { columns, values } = results[0]
		const pathIdx = columns.indexOf('path')
		const mtimeIdx = columns.indexOf('mtime')
		const sizeIdx = columns.indexOf('size')
		const hashIdx = columns.indexOf('hash')
		const isDirIdx = columns.indexOf('is_dir')
		return values.map((row) => ({
			path: row[pathIdx] as string,
			mtime: row[mtimeIdx] as number,
			size: row[sizeIdx] as number,
			hash: row[hashIdx] as string,
			isDir: row[isDirIdx] as number,
		}))
	}

	getFile(path: string): DBFile | undefined {
		const stmt = this.sqlDb.prepare(
			'SELECT path, mtime, size, hash, is_dir FROM files WHERE path = ?',
		)
		stmt.bind([path])
		if (stmt.step()) {
			const cols = stmt.getColumnNames()
			const vals = stmt.get()
			stmt.free()
			return {
				path: vals[cols.indexOf('path')] as string,
				mtime: vals[cols.indexOf('mtime')] as number,
				size: vals[cols.indexOf('size')] as number,
				hash: vals[cols.indexOf('hash')] as string,
				isDir: vals[cols.indexOf('is_dir')] as number,
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
			'INSERT OR REPLACE INTO files (path, mtime, size, hash, is_dir) VALUES (?, ?, ?, ?, ?)',
			[file.path, file.mtime, file.size, file.hash, file.isDir],
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
        is_dir INTEGER DEFAULT 0
      )
    `)
		db.run(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `)
	}

	private static setMeta(db: SqlJsDatabase, key: string, value: string): void {
		db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
			key,
			value,
		])
	}
}
