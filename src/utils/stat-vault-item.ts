import { normalizePath, Vault } from 'obsidian'
import { basename } from 'path-browserify'
import { StatModel } from '~/model/stat.model'

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
