/**
 * 加密设置页面
 *
 * 提供:
 * - 启用/禁用端到端加密
 * - 密码设置/修改
 * - 明文→密文迁移
 * - 密码警告提示
 * - 新设备密钥恢复
 */

import { Modal, Notice, Setting } from 'obsidian'
import type { App } from 'obsidian'
import type WebdavSyncPlugin from '~/index'
import { EncryptionMigrationModal } from '~/components/EncryptionMigrationModal'
import {
	getPBKDF2Iterations,
	loadEncryptionKey,
	setupEncryption,
	verifyPassword,
	showRestoreKeyModal,
	findLocalEncryptedFiles,
	repairLocalEncryptedFiles,
} from '~/crypto'
import BaseSettings from './settings.base'

export default class EncryptionSettingsTab extends BaseSettings {
	async display(): Promise<void> {
		const { containerEl, plugin } = this

		containerEl.empty()

		new Setting(containerEl).setName('端到端加密').setHeading()

		// 密码警告
		const warningEl = containerEl.createDiv({
			cls: 'nutstore-encryption-warning',
		})
		warningEl.createEl('p', {
			text: '⚠️ 启用加密后，远端文件将以密文存储，服务器无法读取内容。',
		})
		warningEl.createEl('p', {
			text: '⚠️ 密码仅保存在本地 SecretStorage 中，无法找回。如果忘记密码，远端加密文件将永久无法解密。',
		})
		warningEl.createEl('p', {
			text: '⚠️ 建议将密码保存在安全的密码管理器中。',
		})

		new Setting(containerEl)
			.setName('启用端到端加密')
			.setDesc('文件上传到 WebDAV 前加密，下载后解密。')
			.addToggle((toggle) =>
				toggle
					.setValue(plugin.settings.encryption.enabled)
					.onChange(async (enabled) => {
						if (enabled) {
							const choice = await showEncryptionSetupChoiceModal(this.app)
							if (choice === 'setup') {
								await showPasswordSetupModal(this.app, plugin)
							} else if (choice === 'restore') {
								const password = await showRestoreKeyModal(
									this.app,
									plugin.settings.encryption,
									'恢复加密密钥',
									'请输入您的加密密码。密钥将从本地配置中的 salt 恢复。',
								)
								if (password) {
									plugin.settings.encryption.enabled = true
									await plugin.saveSettings()
									new Notice('密钥已成功恢复', 5000)
								}
							} else {
								plugin.settings.encryption.enabled = false
								await plugin.saveSettings()
							}
							this.display()
						} else {
							plugin.settings.encryption.enabled = false
							await plugin.saveSettings()
							this.display()
						}
					}),
			)

		if (plugin.settings.encryption.enabled) {
			const key = await loadEncryptionKey(this.app, plugin.settings.encryption)

			if (!key) {
				// 密钥不可用：显示恢复 UI
				const keyMissingEl = containerEl.createDiv({
					cls: 'nutstore-encryption-warning',
				})
				keyMissingEl.createEl('p', {
					text: '⚠️ 加密密钥未找到。您可能在新设备上使用插件，或密钥已被清除。',
				})
				keyMissingEl.createEl('p', {
					text: '请输入加密密码以恢复密钥。',
				})

				new Setting(containerEl)
					.setName('恢复密钥')
					.setDesc('输入密码从已有的 salt 恢复加密密钥，不会更改加密配置。')
					.addButton((btn) =>
						btn
							.setButtonText('恢复密钥')
							.setCta()
							.onClick(async () => {
								await showPasswordRestoreModal(this.app, plugin)
								this.display()
							}),
					)
				return
			}

			const iterations = getPBKDF2Iterations()
			new Setting(containerEl)
				.setName('加密状态')
				.setDesc(`已启用 (PBKDF2 迭代次数: ${iterations.toLocaleString()})`)

			// Salt + KeyHash 展示（用于迁移到新设备）
			const saltValue = plugin.settings.encryption.salt
			const keyHashValue = plugin.settings.encryption.keyHash
			new Setting(containerEl)
				.setName('Salt（用于新设备恢复）')
				.setDesc(saltValue || '未设置')
				.addButton((btn) =>
					btn
						.setButtonText('复制 salt')
						.setCta()
						.onClick(async () => {
							await copyToClipboard(saltValue, 'salt')
							new Notice('salt 已复制到剪贴板', 3000)
						}),
				)

			new Setting(containerEl)
				.setName('Key Hash')
				.setDesc(keyHashValue || '未设置')
				.addButton((btn) =>
					btn.setButtonText('复制 keyHash').onClick(async () => {
						await copyToClipboard(keyHashValue, 'keyHash')
						new Notice('keyHash 已复制到剪贴板', 3000)
					}),
				)

			new Setting(containerEl)
				.setName('迁移现有文件')
				.setDesc('将远端已有的明文文件加密。首次启用加密后建议执行。')
				.addButton((btn) =>
					btn.setButtonText('开始迁移').onClick(async () => {
						await showMigrationModal(this.app, plugin)
					}),
				)

			new Setting(containerEl)
				.setName('修复本地加密文件')
				.setDesc(
					'扫描本地文件，解密因密钥缺失而残留的密文数据。仅在本地出现异常加密文件时使用。',
				)
				.addButton((btn) =>
					btn.setButtonText('开始修复').onClick(async () => {
						await showLocalRepairModal(this.app, plugin)
						this.display()
					}),
				)

			new Setting(containerEl)
				.setName('修改密码')
				.setDesc('修改密码后，需要通过迁移或重新同步来重新加密远端文件。')
				.addButton((btn) =>
					btn.setButtonText('修改').onClick(async () => {
						await showPasswordChangeModal(this.app, plugin)
						this.display()
					}),
				)
		}
	}
}

/**
 * 显示迁移 Modal
 */
async function showMigrationModal(
	app: App,
	plugin: WebdavSyncPlugin,
): Promise<void> {
	const key = await loadEncryptionKey(app, plugin.settings.encryption)
	if (!key) {
		new Notice('无法加载加密密钥，请重新设置密码', 5000)
		return
	}

	if (!plugin.isAccountConfigured()) {
		new Notice('请先配置 WebDAV 账号', 5000)
		return
	}

	const webdav = await plugin.webDAVService.createWebDAVClient()
	new EncryptionMigrationModal(app, {
		webdav,
		remoteBaseDir: plugin.remoteBaseDir,
		encryptionKey: key,
	}).open()
}

/**
 * 密码设置 Modal
 */
async function showPasswordSetupModal(
	app: App,
	plugin: WebdavSyncPlugin,
): Promise<void> {
	return new Promise((resolve) => {
		const modal = new Modal(app)
		modal.titleEl.setText('设置加密密码')

		const contentEl = modal.contentEl

		contentEl.createEl('p', {
			text: '请输入并确认您的加密密码。此密码将用于加密所有上传到 WebDAV 的文件。',
		})

		let passwordInput: HTMLInputElement
		let confirmInput: HTMLInputElement
		let errorEl: HTMLElement

		new Setting(contentEl).setName('密码').addText((text) => {
			text.inputEl.type = 'password'
			text.inputEl.placeholder = '输入密码 (至少 8 个字符)'
			passwordInput = text.inputEl
		})

		new Setting(contentEl).setName('确认密码').addText((text) => {
			text.inputEl.type = 'password'
			text.inputEl.placeholder = '再次输入密码'
			confirmInput = text.inputEl
		})

		errorEl = contentEl.createDiv({ cls: 'nutstore-encryption-error' })
		errorEl.style.color = 'var(--text-error)'
		errorEl.style.display = 'none'

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText('取消').onClick(() => {
				plugin.settings.encryption.enabled = false
				plugin.saveSettings()
				modal.close()
				resolve()
			}),
		)

		new Setting(contentEl).addButton((btn) => {
			btn
				.setButtonText('确认设置')
				.setCta()
				.onClick(async () => {
					const password = passwordInput.value
					const confirm = confirmInput.value

					if (password.length < 8) {
						errorEl.setText('密码至少需要 8 个字符')
						errorEl.style.display = 'block'
						return
					}

					if (password !== confirm) {
						errorEl.setText('两次输入的密码不一致')
						errorEl.style.display = 'block'
						return
					}

					btn.setDisabled(true)
					btn.setButtonText('正在生成密钥...')

					try {
						await setupEncryption(app, password, plugin.settings.encryption)
						await plugin.saveSettings()
						modal.close()

						// 提示迁移
						new Notice('加密已启用。可在设置中迁移现有明文文件。', 8000)
						resolve()
					} catch (e) {
						errorEl.setText('密钥生成失败: ' + String(e))
						errorEl.style.display = 'block'
						btn.setDisabled(false)
						btn.setButtonText('确认设置')
					}
				})
		})

		modal.open()
	})
}

/**
 * 密码修改 Modal
 */
async function showPasswordChangeModal(
	app: App,
	plugin: WebdavSyncPlugin,
): Promise<void> {
	return new Promise((resolve) => {
		const modal = new Modal(app)
		modal.titleEl.setText('修改加密密码')

		const contentEl = modal.contentEl

		contentEl.createEl('p', {
			text: '修改密码后，远端已有的加密文件需要重新加密。请在设置中执行迁移操作。',
		})

		let oldPasswordInput: HTMLInputElement
		let newPasswordInput: HTMLInputElement
		let confirmInput: HTMLInputElement
		let errorEl: HTMLElement

		new Setting(contentEl).setName('旧密码').addText((text) => {
			text.inputEl.type = 'password'
			text.inputEl.placeholder = '输入旧密码'
			oldPasswordInput = text.inputEl
		})

		new Setting(contentEl).setName('新密码').addText((text) => {
			text.inputEl.type = 'password'
			text.inputEl.placeholder = '输入新密码 (至少 8 个字符)'
			newPasswordInput = text.inputEl
		})

		new Setting(contentEl).setName('确认新密码').addText((text) => {
			text.inputEl.type = 'password'
			text.inputEl.placeholder = '再次输入新密码'
			confirmInput = text.inputEl
		})

		errorEl = contentEl.createDiv({ cls: 'nutstore-encryption-error' })
		errorEl.style.color = 'var(--text-error)'
		errorEl.style.display = 'none'

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText('取消').onClick(() => {
				modal.close()
				resolve()
			}),
		)

		new Setting(contentEl).addButton((btn) => {
			btn
				.setButtonText('确认修改')
				.setCta()
				.onClick(async () => {
					const oldPassword = oldPasswordInput.value
					const newPassword = newPasswordInput.value
					const confirm = confirmInput.value

					if (newPassword.length < 8) {
						errorEl.setText('新密码至少需要 8 个字符')
						errorEl.style.display = 'block'
						return
					}

					if (newPassword !== confirm) {
						errorEl.setText('两次输入的新密码不一致')
						errorEl.style.display = 'block'
						return
					}

					// 验证旧密码
					const valid = await verifyPassword(
						oldPassword,
						plugin.settings.encryption.salt,
						plugin.settings.encryption.keyHash,
						plugin.settings.encryption.iterations,
					)

					if (!valid) {
						errorEl.setText('旧密码错误')
						errorEl.style.display = 'block'
						return
					}

					btn.setDisabled(true)
					btn.setButtonText('正在生成新密钥...')

					try {
						// 使用 setupEncryption 覆盖旧密钥
						await setupEncryption(app, newPassword, plugin.settings.encryption)
						await plugin.saveSettings()

						new Notice(
							'密码已修改。请在设置中执行迁移以用新密钥重新加密远端文件。',
							8000,
						)
						modal.close()
						resolve()
					} catch (e) {
						errorEl.setText('密钥生成失败: ' + String(e))
						errorEl.style.display = 'block'
						btn.setDisabled(false)
						btn.setButtonText('确认修改')
					}
				})
		})

		modal.open()
	})
}

/**
 * 加密方式选择 Modal
 *
 * 开启加密时让用户选择「设置新密码」还是「从已有加密恢复」。
 */
async function showEncryptionSetupChoiceModal(
	app: App,
): Promise<'setup' | 'restore' | null> {
	return new Promise((resolve) => {
		const modal = new Modal(app)
		modal.titleEl.setText('设置加密方式')

		const contentEl = modal.contentEl
		contentEl.createEl('p', {
			text: '如果其他设备已启用加密，请选择恢复；否则请设置新密码。',
		})

		// 选项卡片容器
		const cardContainer = contentEl.createDiv({
			cls: 'nutstore-encryption-choice-container',
		})

		// 选项 1：设置新密码
		const setupCard = cardContainer.createDiv({
			cls: 'nutstore-encryption-choice-card',
		})
		const setupHeader = setupCard.createDiv({
			cls: 'nutstore-encryption-choice-header',
		})
		setupHeader.createSpan({ text: '🔑 设置新密码' })
		setupCard.createEl('p', {
			text: '创建新的加密密码。首次使用加密功能时选择此项。',
			cls: 'nutstore-encryption-choice-desc',
		})
		new Setting(setupCard).addButton((btn) =>
			btn
				.setButtonText('设置新密码')
				.setCta()
				.onClick(() => {
					modal.close()
					resolve('setup')
				}),
		)

		// 选项 2：从已有加密恢复
		const restoreCard = cardContainer.createDiv({
			cls: 'nutstore-encryption-choice-card',
		})
		const restoreHeader = restoreCard.createDiv({
			cls: 'nutstore-encryption-choice-header',
		})
		restoreHeader.createSpan({ text: '🔓 从已有加密恢复' })
		restoreCard.createEl('p', {
			text: '在新设备上恢复已有的加密密钥，继续访问远端加密数据。',
			cls: 'nutstore-encryption-choice-desc',
		})
		new Setting(restoreCard).addButton((btn) =>
			btn.setButtonText('从已有加密恢复').onClick(() => {
				modal.close()
				resolve('restore')
			}),
		)

		// 底部取消
		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText('取消').onClick(() => {
				modal.close()
				resolve(null)
			}),
		)

		modal.open()
	})
}

/**
 * 本地加密文件修复 Modal
 *
 * 扫描本地 vault 文件，检测并解密因密钥缺失残留在本地的密文数据。
 */
async function showLocalRepairModal(
	app: App,
	plugin: WebdavSyncPlugin,
): Promise<void> {
	const key = await loadEncryptionKey(app, plugin.settings.encryption)
	if (!key) {
		new Notice('无法加载加密密钥', 5000)
		return
	}

	return new Promise((resolve) => {
		const modal = new Modal(app)
		modal.titleEl.setText('修复本地加密文件')

		const contentEl = modal.contentEl
		contentEl.createEl('p', {
			text: '正在统计文件数量...',
			cls: 'nutstore-migration-scanning',
		})
		modal.open()
		;(async () => {
			const vault = plugin.app.vault

			const scanProgressEl = contentEl.createEl('p', {
				cls: 'nutstore-migration-progress-text',
			})

			const encryptedFiles = await findLocalEncryptedFiles(
				vault,
				(current, total, filePath) => {
					scanProgressEl.setText(
						`正在扫描: ${current} / ${total} — ${filePath}`,
					)
				},
			)

			contentEl.empty()

			if (encryptedFiles.length === 0) {
				contentEl.createEl('p', {
					text: '✅ 未发现本地加密文件，无需修复。',
				})
				new Setting(contentEl).addButton((btn) =>
					btn.setButtonText('关闭').onClick(() => {
						modal.close()
						resolve()
					}),
				)
				return
			}

			contentEl.createEl('p', {
				text: `发现 ${encryptedFiles.length} 个本地加密文件需要修复:`,
			})
			const listEl = contentEl.createEl('ul')
			for (const f of encryptedFiles) {
				listEl.createEl('li', { text: f.path })
			}

			const progressEl = contentEl.createDiv({
				cls: 'nutstore-migration-progress',
			})
			const progressBar = progressEl.createEl('div', {
				cls: 'nutstore-migration-progress-bar',
			})
			const progressText = progressEl.createEl('span', {
				cls: 'nutstore-migration-progress-text',
			})

			let isRunning = false

			new Setting(contentEl)
				.addButton((btn) =>
					btn
						.setButtonText('开始修复')
						.setCta()
						.onClick(async () => {
							if (isRunning) return
							isRunning = true
							btn.setDisabled(true)
							btn.setButtonText('修复中...')

							progressBar.style.width = '0%'
							progressText.setText(`0 / ${encryptedFiles.length}`)

							try {
								const result = await repairLocalEncryptedFiles(
									vault,
									key,
									encryptedFiles,
									(current, total, filePath) => {
										progressText.setText(`${current} / ${total} — ${filePath}`)
										const pct = Math.round((current / total) * 100)
										progressBar.style.width = `${pct}%`
									},
								)

								contentEl.empty()
								contentEl.createEl('p', {
									text: `修复完成: 成功 ${result.success} 个`,
								})
								if (result.failed === 0) {
									contentEl.createEl('p', {
										text: '✅ 所有加密文件已解密。',
									})
								} else {
									const parts: string[] = []
									if (result.decryptErrors > 0)
										parts.push(`${result.decryptErrors} 个解密失败`)
									if (result.writeErrors > 0)
										parts.push(`${result.writeErrors} 个写入失败`)
									if (result.readErrors > 0)
										parts.push(`${result.readErrors} 个读取失败`)

									if (result.success === 0) {
										contentEl.createEl('p', {
											text: `⚠️ 全部失败（${parts.join('，')}）。密钥可能不匹配，请确认使用的是加密文件时的原始密码。可尝试在设置 → 加密中重新恢复密钥。`,
											cls: 'nutstore-encryption-error',
										})
									} else {
										contentEl.createEl('p', {
											text: `⚠️ ${result.failed} 个文件失败（${parts.join('，')}）。`,
											cls: 'nutstore-text-warning',
										})
									}
								}
							} catch (err) {
								console.error('[obsidian-webdav-sync] repair error:', err)
								contentEl.empty()
								contentEl.createEl('p', {
									text: `❌ 修复过程出错: ${err instanceof Error ? err.message : String(err)}`,
									cls: 'nutstore-encryption-error',
								})
							}
							new Setting(contentEl).addButton((btn2) =>
								btn2.setButtonText('关闭').onClick(() => {
									modal.close()
									resolve()
								}),
							)
						}),
				)
				.addButton((btn) =>
					btn.setButtonText('取消').onClick(() => {
						modal.close()
						resolve()
					}),
				)
		})()
	})
}

/**
 * 密码恢复 Modal（设置页面入口）
 *
 * 使用共用的 showRestoreKeyModal，成功后显示提示并刷新页面。
 */
async function showPasswordRestoreModal(
	app: App,
	plugin: WebdavSyncPlugin,
): Promise<void> {
	const password = await showRestoreKeyModal(
		app,
		plugin.settings.encryption,
		'恢复加密密钥',
		'请输入您的加密密码。密钥将从本地配置中的 salt 恢复，不会更改加密设置。',
	)
	if (password) {
		await plugin.saveSettings()
		new Notice('密钥已成功恢复', 5000)
	}
}

async function copyToClipboard(value: string, label: string): Promise<void> {
	if (navigator?.clipboard?.writeText) {
		await navigator.clipboard.writeText(value)
		new Notice(`${label} 已复制到剪贴板`, 3000)
	} else {
		new Notice(`请手动复制 ${label}: ${value}`, 10000)
	}
}
