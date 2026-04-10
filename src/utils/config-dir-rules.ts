import type NutstorePlugin from '~/index'
import type { GlobMatchOptions } from './glob-match'

export type ConfigDirSyncMode = 'none' | 'bookmarks' | 'all'

export interface EffectiveFilterRules {
	exclusionRules: GlobMatchOptions[]
	inclusionRules: GlobMatchOptions[]
	configDir: string
	configDirSyncMode: ConfigDirSyncMode
}

const CONFIG_DIR_SYSTEM_EXCLUSION_SUFFIXES = [
	'plugins/**/node_modules',
	'plugins/**/.git',
	'plugins/**/.pnpm-store',
	'workspace',
	'workspace.json',
] as const

function normalizePathForCheck(rawPath: string) {
	return rawPath
		.replace(/\\/g, '/')
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
}

function isSameOrSubPath(path: string, baseDir: string) {
	return path === baseDir || path.startsWith(`${baseDir}/`)
}

export function isPathAllowedByConfigDirMode(
	path: string,
	configDir: string,
	mode: ConfigDirSyncMode,
) {
	const normalizedPath = normalizePathForCheck(path)
	const normalizedConfigDir = normalizePathForCheck(configDir)

	if (!isSameOrSubPath(normalizedPath, normalizedConfigDir)) {
		return true
	}

	if (mode === 'none') {
		return false
	}
	if (mode === 'bookmarks') {
		return normalizedPath === `${normalizedConfigDir}/bookmarks.json`
	}
	return true
}

function makeCaseSensitiveRule(expr: string): GlobMatchOptions {
	return { expr, options: { caseSensitive: true } }
}

export function getConfigDirSystemTraversalRules(
	configDir: string,
): GlobMatchOptions[] {
	return CONFIG_DIR_SYSTEM_EXCLUSION_SUFFIXES.map((suffix) =>
		makeCaseSensitiveRule(`${configDir}/${suffix}`),
	)
}

export function getConfigDirSystemFilterRules(configDir: string): GlobMatchOptions[] {
	return getConfigDirSystemTraversalRules(configDir).flatMap((rule) => [
		makeCaseSensitiveRule(rule.expr),
		makeCaseSensitiveRule(`${rule.expr}/**`),
	])
}

/**
 * Computes the effective exclusion/inclusion filter rules by merging the
 * user's stored rules with the system-managed configDir rules derived from
 * the current configDirSyncMode setting.
 *
 * Does NOT modify plugin.settings — returns a new rule set for use at
 * sync time only.
 */
export function computeEffectiveFilterRules(
	plugin: NutstorePlugin,
): EffectiveFilterRules {
	const configDir = plugin.app.vault.configDir
	const mode: ConfigDirSyncMode = plugin.settings.configDirSyncMode ?? 'none'

	const exclusionRules = plugin.settings.filterRules.exclusionRules.filter(
		(r) => r.expr !== configDir && r.expr !== `${configDir}/**`,
	)
	const inclusionRules = plugin.settings.filterRules.inclusionRules.filter(
		(r) => r.expr !== `${configDir}/bookmarks.json`,
	)
	exclusionRules.push(...getConfigDirSystemFilterRules(configDir))

	if (mode === 'none') {
		exclusionRules.push({ expr: configDir, options: { caseSensitive: false } })
	} else if (mode === 'bookmarks') {
		exclusionRules.push({
			expr: `${configDir}/**`,
			options: { caseSensitive: false },
		})
		inclusionRules.push({
			expr: `${configDir}/bookmarks.json`,
			options: { caseSensitive: false },
		})
	}
	// mode === 'all': no additional rules — configDir traversed freely

	return {
		exclusionRules,
		inclusionRules,
		configDir,
		configDirSyncMode: mode,
	}
}
