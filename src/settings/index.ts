import type { App } from 'obsidian'
import { PluginSettingTab, Setting } from 'obsidian'
import i18n from '~/i18n'
import type WebdavSyncPlugin from '~/index'
import type { EncryptionSettings } from '~/crypto/types'
import type { ConflictStrategy } from '~/sync/tasks/conflict-resolve.task'
import type { GlobMatchOptions } from '~/utils/glob-match'
import waitUntil from '~/utils/wait-until'
import AccountSettings from './account'
import CommonSettings from './common'
import EncryptionSettingsTab from './encryption'
import FilterSettings from './filter'
import LogSettings from './log'

export enum SyncMode {
	STRICT = 'strict',
	LOOSE = 'loose',
}

export interface NutstoreSettings {
	webdavEndpoint: string
	webdavUsername: string
	webdavPassword: string
	remoteDir: string
	useGitStyle: boolean
	conflictStrategy: ConflictStrategy
	confirmBeforeSync: boolean
	confirmBeforeDeleteInAutoSync: boolean
	syncMode: SyncMode
	filterRules: {
		exclusionRules: GlobMatchOptions[]
		inclusionRules: GlobMatchOptions[]
	}
	skipLargeFiles: {
		maxSize: string
	}
	realtimeSync: boolean
	startupSyncDelaySeconds: number
	autoSyncIntervalSeconds: number
	language?: 'zh' | 'en'
	configDirSyncMode?: 'none' | 'bookmarks' | 'all'
	encryption: EncryptionSettings
}

let pluginInstance: WebdavSyncPlugin | null = null

export function setPluginInstance(plugin: WebdavSyncPlugin | null) {
	pluginInstance = plugin
}

export function waitUntilPluginInstance() {
	return waitUntil(() => !!pluginInstance, 100)
}

export async function useSettings() {
	await waitUntilPluginInstance()
	return pluginInstance!.settings
}

export class NutstoreSettingTab extends PluginSettingTab {
	plugin: WebdavSyncPlugin
	accountSettings: AccountSettings
	commonSettings: CommonSettings
	filterSettings: FilterSettings
	logSettings: LogSettings
	encryptionSettings: EncryptionSettingsTab
	warningContainerEl: HTMLElement

	constructor(app: App, plugin: WebdavSyncPlugin) {
		super(app, plugin)
		this.plugin = plugin
		this.warningContainerEl = this.containerEl.createDiv()
		this.accountSettings = new AccountSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl.createDiv(),
		)
		this.commonSettings = new CommonSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl.createDiv(),
		)
		this.filterSettings = new FilterSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl.createDiv(),
		)
		this.encryptionSettings = new EncryptionSettingsTab(
			this.app,
			this.plugin,
			this,
			this.containerEl.createDiv(),
		)
		this.logSettings = new LogSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl.createDiv(),
		)
	}

	async display() {
		this.warningContainerEl.empty()
		new Setting(this.warningContainerEl)
			.setName(i18n.t('settings.backupWarning.name'))
			.setDesc(i18n.t('settings.backupWarning.desc'))
		await this.accountSettings.display()
		await this.commonSettings.display()
		await this.filterSettings.display()
		await this.encryptionSettings.display()
		await this.logSettings.display()
	}

	async hide() {
		await this.accountSettings.hide()
	}
}
