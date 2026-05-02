import type { Vault } from 'obsidian'
import { normalizePath } from 'obsidian'
import { basename } from 'path-browserify'
import type { StatModel } from '~/model/stat.model'

export async function statVaultItem(
	vault: Vault,
	path: string,
): Promise<StatModel | undefined> {
	path = normalizePath(path)
	const stat = await vault.adapter.stat(path)
	if (!stat) {
		return undefined
	}
	if (stat.type === 'folder') {
		return {
			path,
			basename: basename(path),
			isDir: true,
			isDeleted: false,
			mtime: stat.mtime,
		}
	}
	if (stat.type === 'file') {
		return {
			path,
			basename: basename(path),
			isDir: false,
			isDeleted: false,
			mtime: stat.mtime,
			size: stat.size,
		}
	}
}
