import { normalizePath, Vault } from 'obsidian'
import { StatModel } from '~/model/stat.model'
import GlobMatch from './glob-match'
import { statVaultItem } from './stat-vault-item'

export async function traverseLocalVault(vault: Vault, from: string) {
	const res: StatModel[] = []
	const q = [from]
	const ignores = [
		new GlobMatch(`${vault.configDir}/plugins/*/node_modules`, {
			caseSensitive: true,
		}),
	]
	function folderFilter(path: string) {
		path = normalizePath(path)
		if (ignores.some((rule) => rule.test(path))) {
			return false
		}
		return true
	}

	while (q.length > 0) {
		const current = q.shift()
		if (current === undefined) {
			continue
		}
		const folderPath = normalizePath(current)
		const folderStat = await vault.adapter.stat(folderPath)
		if (!folderStat || folderStat.type !== 'folder') {
			continue
		}
		const { files, folders } = await vault.adapter.list(folderPath)
		const normalizedFiles = files.map((path) => normalizePath(path))
		const normalizedFolders = folders
			.map((path) => normalizePath(path))
			.filter(folderFilter)
		q.push(...normalizedFolders)
		const contents = (
			await Promise.all(
				[...normalizedFiles, ...normalizedFolders].map((path) =>
					statVaultItem(vault, path),
				),
			)
		).filter((item): item is StatModel => item !== undefined)
		res.push(...contents)
	}
	return res
}
