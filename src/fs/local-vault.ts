import type { Vault } from 'obsidian'
import { useSettings } from '~/settings'
import type { ConfigDirSyncMode } from '~/utils/config-dir-rules'
import { computeEffectiveFilterRulesFromParts } from '~/utils/config-dir-rules'
import type { GlobMatchOptions } from '~/utils/glob-match'
import GlobMatch, {
	isVoidGlobMatchOptions,
	needIncludeFromGlobRules,
} from '~/utils/glob-match'
import { traverseLocalVault } from '~/utils/traverse-local-vault'
import type AbstractFileSystem from './fs.interface'

export class LocalVaultFileSystem implements AbstractFileSystem {
	constructor(
		private readonly options: {
			vault: Vault
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
		const filterRules =
			this.options.filterRules ??
			(settings
				? computeEffectiveFilterRulesFromParts(
						this.options.vault.configDir,
						settings.configDirSyncMode ?? 'none',
						settings.filterRules,
					)
				: undefined)
		const exclusions = this.buildRules(filterRules?.exclusionRules)
		const inclusions = this.buildRules(filterRules?.inclusionRules)

		const stats = await traverseLocalVault(
			this.options.vault,
			this.options.vault.getRoot().path,
		)
		const includedStats = stats.filter((stat) =>
			needIncludeFromGlobRules(stat.path, inclusions, exclusions),
		)
		const completeStatPaths = new Set(includedStats.map((s) => s.path))
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
