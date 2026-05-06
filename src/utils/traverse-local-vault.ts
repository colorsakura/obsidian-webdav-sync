import type { Vault } from 'obsidian'
import { normalizePath } from 'obsidian'
import type { StatModel } from '~/model/stat.model'
import { getConfigDirSystemTraversalRules } from './config-dir-rules'
import GlobMatch from './glob-match'
import { statVaultItem } from './stat-vault-item'

export async function traverseLocalVault(vault: Vault, from: string) {
	const res: StatModel[] = []
	const q = [from]
	const ignores = getConfigDirSystemTraversalRules(vault.configDir).map(
		(rule) => new GlobMatch(rule.expr, rule.options),
	)
	function folderFilter(path: string) {
		path = normalizePath(path)
		return !ignores.some((rule) => rule.test(path));

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
