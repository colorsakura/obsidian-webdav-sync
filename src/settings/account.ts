import { Notice, Setting } from 'obsidian'
import i18n from '~/i18n'
import { is503Error } from '~/utils/is-503-error'
import BaseSettings from './settings.base'

export default class AccountSettings extends BaseSettings {
	async display() {
		this.containerEl.empty()
		new Setting(this.containerEl)
			.setName(i18n.t('settings.sections.account'))
			.setHeading()

		new Setting(this.containerEl)
			.setName(i18n.t('settings.webdavEndpoint.name'))
			.setDesc(i18n.t('settings.webdavEndpoint.desc'))
			.addText((text) =>
				text
					.setPlaceholder(i18n.t('settings.webdavEndpoint.placeholder'))
					.setValue(this.plugin.settings.webdavEndpoint)
					.onChange(async (value) => {
						this.plugin.settings.webdavEndpoint = value
						await this.plugin.saveSettings()
					}),
			)

		new Setting(this.containerEl)
			.setName(i18n.t('settings.webdavUsername.name'))
			.setDesc(i18n.t('settings.webdavUsername.desc'))
			.addText((text) =>
				text
					.setPlaceholder(i18n.t('settings.webdavUsername.placeholder'))
					.setValue(this.plugin.settings.webdavUsername)
					.onChange(async (value) => {
						this.plugin.settings.webdavUsername = value
						await this.plugin.saveSettings()
					}),
			)

		new Setting(this.containerEl)
			.setName(i18n.t('settings.webdavPassword.name'))
			.setDesc(i18n.t('settings.webdavPassword.desc'))
			.addText((text) => {
				text
					.setPlaceholder(i18n.t('settings.webdavPassword.placeholder'))
					.setValue(this.plugin.settings.webdavPassword)
					.onChange(async (value) => {
						this.plugin.settings.webdavPassword = value
						await this.plugin.saveSettings()
					})
				text.inputEl.type = 'password'
			})

		this.displayCheckConnection()
	}

	async hide() {
		// No cleanup needed
	}

	private displayCheckConnection() {
		new Setting(this.containerEl)
			.setName(i18n.t('settings.checkConnection.name'))
			.setDesc(i18n.t('settings.checkConnection.desc'))
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.checkConnection.name'))
					.onClick(async (e) => {
						const buttonEl = e.target as HTMLElement
						buttonEl.classList.add('connection-button', 'loading')
						buttonEl.classList.remove('success', 'error')
						buttonEl.textContent = i18n.t('settings.checkConnection.name')
						try {
							const { success, error } =
								await this.plugin.webDAVService.checkWebDAVConnection()
							buttonEl.classList.remove('loading')
							if (success) {
								buttonEl.classList.add('success')
								buttonEl.textContent = i18n.t(
									'settings.checkConnection.successButton',
								)
								new Notice(i18n.t('settings.checkConnection.success'))
							} else if (error && is503Error(error)) {
								buttonEl.classList.add('error')
								buttonEl.textContent = i18n.t('sync.error.requestsTooFrequent')
								new Notice(i18n.t('sync.error.requestsTooFrequent'))
							} else {
								buttonEl.classList.add('error')
								buttonEl.textContent = i18n.t(
									'settings.checkConnection.failureButton',
								)
								new Notice(i18n.t('settings.checkConnection.failure'))
							}
						} catch {
							buttonEl.classList.remove('loading')
							buttonEl.classList.add('error')
							buttonEl.textContent = i18n.t(
								'settings.checkConnection.failureButton',
							)
							new Notice(i18n.t('settings.checkConnection.failure'))
						}
					})
			})
	}
}
