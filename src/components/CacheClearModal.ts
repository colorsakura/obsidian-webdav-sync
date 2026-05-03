import { Modal, Setting } from 'obsidian'
import i18n from '~/i18n'
import { traverseWebDAVKV } from '~/storage/kv'
import logger from '~/utils/logger'
import type NutstorePlugin from '..'

export interface CacheClearOptions {
	traverseWebDAVEnabled: boolean
}

export default class CacheClearModal extends Modal {
	private options: CacheClearOptions = {
		traverseWebDAVEnabled: false,
	}

	constructor(
		private plugin: NutstorePlugin,
		private onSuccess?: (options: CacheClearOptions) => void,
	) {
		super(plugin.app)
	}

	onOpen() {
		const { contentEl } = this

		new Setting(contentEl)
			.setName(i18n.t('settings.cache.clearModal.title'))
			.setDesc(i18n.t('settings.cache.clearModal.description'))

		const optionsContainer = contentEl.createDiv({
			cls: 'py-2',
		})

		// TraverseWebDAV Cache Option
		new Setting(optionsContainer)
			.setName(i18n.t('settings.cache.clearModal.traverseWebDAVCache.name'))
			.setDesc(i18n.t('settings.cache.clearModal.traverseWebDAVCache.desc'))
			.addToggle((toggle) => {
				toggle
					.setValue(this.options.traverseWebDAVEnabled)
					.onChange((value) => {
						this.options.traverseWebDAVEnabled = value
					})
			})

		// Action buttons
		new Setting(contentEl)
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.cache.clearModal.cancel'))
					.onClick(() => {
						this.close()
					})
			})
			.addButton((button) => {
				let confirmed = false
				button
					.setButtonText(i18n.t('settings.cache.clear'))
					.onClick(async () => {
						if (confirmed) {
							try {
								if (this.onSuccess) {
									this.onSuccess(this.options)
								}
								this.close()
							} catch (error) {
								logger.error('Error clearing cache:', error)
							} finally {
								button.setButtonText(
									i18n.t('settings.cache.clearModal.confirm'),
								)
								button.buttonEl.classList.remove('mod-warning')
								confirmed = false
							}
						} else {
							confirmed = true
							button
								.setButtonText(i18n.t('settings.cache.confirm'))
								.setWarning()
						}
					})

				button.buttonEl.addEventListener('blur', () => {
					if (confirmed) {
						confirmed = false
						button.setButtonText(i18n.t('settings.cache.clear'))
						button.buttonEl.classList.remove('mod-warning')
					}
				})
			})
	}

	onClose() {
		const { contentEl } = this
		contentEl.empty()
	}

	/**
	 * Static method to clear selected caches
	 */
	static async clearSelectedCaches(options: CacheClearOptions) {
		const { traverseWebDAVEnabled } = options
		const cleared = []

		try {
			if (traverseWebDAVEnabled) {
				await traverseWebDAVKV.clear()
				cleared.push(
					i18n.t('settings.cache.clearModal.traverseWebDAVCache.name'),
				)
			}

			return cleared
		} catch (error) {
			logger.error('Error clearing caches:', error)
			throw error
		}
	}
}
