/**
 * 共用密码恢复 Modal
 *
 * 用于同步前置检测和设置页面的密钥恢复场景。
 * 用户输入密码 → 调用 restoreEncryption → 返回结果。
 */

import { App, Modal, Setting } from 'obsidian'
import type { EncryptionSettings } from './types'
import { restoreEncryption, SECRET_ID } from './key-store'

export function showRestoreKeyModal(
	app: App,
	encryption: EncryptionSettings,
	title: string,
	description: string,
): Promise<string | null> {
	return new Promise((resolve) => {
		const modal = new Modal(app)
		modal.titleEl.setText(title)

		const contentEl = modal.contentEl
		contentEl.createEl('p', { text: description })

		let passwordInput: HTMLInputElement
		let errorEl: HTMLElement
		let saltInput: HTMLInputElement | undefined
		let keyHashInput: HTMLInputElement | undefined
		let advancedEl: HTMLElement | undefined

		new Setting(contentEl).setName('密码').addText((text) => {
			text.inputEl.type = 'password'
			text.inputEl.placeholder = '输入加密密码'
			passwordInput = text.inputEl
		})

		// 高级选项：手动输入 salt / keyHash（用于跨设备手动迁移场景）
		const advancedToggle = contentEl.createEl('a', {
			text: '▸ 高级选项（手动输入 salt）',
			cls: 'nutstore-advanced-toggle',
		})
		advancedToggle.style.cursor = 'pointer'
		advancedToggle.style.display = 'block'
		advancedToggle.style.marginBottom = '12px'
		advancedToggle.style.fontSize = '0.9em'

		advancedEl = contentEl.createDiv()
		advancedEl.style.display = 'none'

		advancedToggle.addEventListener('click', () => {
			const isOpen = advancedEl!.style.display !== 'none'
			advancedEl!.style.display = isOpen ? 'none' : 'block'
			advancedToggle.text = isOpen
				? '▸ 高级选项（手动输入 salt）'
				: '▾ 高级选项（手动输入 salt）'
		})

		new Setting(advancedEl)
			.setName('Salt')
			.setDesc('从旧设备复制粘贴 salt（base64）')
			.addText((text) => {
				text.inputEl.placeholder = encryption.salt || '粘贴 salt...'
				text.setValue(encryption.salt || '')
				saltInput = text.inputEl
			})

		new Setting(advancedEl)
			.setName('Key Hash')
			.setDesc('从旧设备复制粘贴 keyHash（hex）')
			.addText((text) => {
				text.inputEl.placeholder = encryption.keyHash || '粘贴 keyHash...'
				text.setValue(encryption.keyHash || '')
				keyHashInput = text.inputEl
			})

		errorEl = contentEl.createDiv({ cls: 'nutstore-encryption-error' })
		errorEl.style.color = 'var(--text-error)'
		errorEl.style.display = 'none'

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText('取消').onClick(() => {
				modal.close()
				resolve(null)
			}),
		)

		new Setting(contentEl).addButton((btn) => {
			btn
				.setButtonText('确认')
				.setCta()
				.onClick(async () => {
					const password = passwordInput.value
					if (!password) {
						errorEl.setText('请输入密码')
						errorEl.style.display = 'block'
						return
					}

					btn.setDisabled(true)
					btn.setButtonText('正在恢复密钥...')

					try {
						// 临时应用用户手动输入的 salt / keyHash
						const origSalt = encryption.salt
						const origHash = encryption.keyHash
						if (saltInput?.value) {
							encryption.salt = saltInput.value
						}
						if (keyHashInput?.value) {
							encryption.keyHash = keyHashInput.value
						}

						const success = await restoreEncryption(app, password, encryption)

						if (!success) {
							// 失败：恢复原始 salt/keyHash
							encryption.salt = origSalt
							encryption.keyHash = origHash
							errorEl.setText('密码错误，请重试')
							errorEl.style.display = 'block'
							btn.setDisabled(false)
							btn.setButtonText('确认')
							return
						}

						// 成功：保持有效的 salt/keyHash，显式设置 secretId
						encryption.secretId = SECRET_ID
						modal.close()
						resolve(password)
					} catch (e) {
						errorEl.setText('密钥恢复失败: ' + String(e))
						errorEl.style.display = 'block'
						btn.setDisabled(false)
						btn.setButtonText('确认')
					}
				})
		})

		modal.open()
	})
}
