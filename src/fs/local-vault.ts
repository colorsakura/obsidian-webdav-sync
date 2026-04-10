import { Vault } from 'obsidian'
import { useSettings } from '~/settings'
import { SyncRecord } from '~/storage/sync-record'
import {
	ConfigDirSyncMode,
	isPathAllowedByConfigDirMode,
} from '~/utils/config-dir-rules'
import GlobMatch, {
	GlobMatchOptions,
	isVoidGlobMatchOptions,
	needIncludeFromGlobRules,
} from '~/utils/glob-match'
import { traverseLocalVault } from '~/utils/traverse-local-vault'
import AbstractFileSystem from './fs.interface'
import completeLossDir from './utils/complete-loss-dir'

export class LocalVaultFileSystem implements AbstractFileSystem {
	constructor(
		private readonly options: {
			vault: Vault
			syncRecord: SyncRecord
			filterRules?: {
				exclusionRules: GlobMatchOptions[]
				inclusionRules: GlobMatchOptions[]
				configDir?: string
				configDirSyncMode?: ConfigDirSyncMode
			}
		},
	) {}

	async walk() {
		const settings = this.options.filterRules ? undefined : await useSettings()
		const filterRules = this.options.filterRules ?? settings?.filterRules
		const configDir = this.options.filterRules?.configDir ?? this.options.vault.configDir
		const configDirSyncMode =
			this.options.filterRules?.configDirSyncMode ??
			settings?.configDirSyncMode ??
			'none'
		const exclusions = this.buildRules(filterRules?.exclusionRules)
		const inclusions = this.buildRules(filterRules?.inclusionRules)

		const stats = await traverseLocalVault(
			this.options.vault,
			this.options.vault.getRoot().path,
		)
		const includedStats = stats.filter((stat) => {
			if (!isPathAllowedByConfigDirMode(stat.path, configDir, configDirSyncMode)) {
				return false
			}
			return needIncludeFromGlobRules(stat.path, inclusions, exclusions)
		})
		const completeStats = completeLossDir(stats, includedStats)
		const completeStatPaths = new Set(completeStats.map((s) => s.path))
		return stats.map((stat) => ({
			stat,
			ignored: !completeStatPaths.has(stat.path),
		}))
	}

	private buildRules(rules: GlobMatchOptions[] = []): GlobMatch[] {
		return rules
			.filter((opt) => !isVoidGlobMatchOptions(opt))
			.map(({ expr, options }) => new GlobMatch(expr, options))
	}
}
