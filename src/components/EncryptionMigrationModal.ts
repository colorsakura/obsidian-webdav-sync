/**
 * 加密迁移 Modal
 *
 * 显示远端文件加密状态，并提供一键迁移功能
 */

import { App, Modal, Notice, Setting } from 'obsidian'
import { WebDAVClient } from 'webdav'
import {
	detectRemoteFiles,
	migrateToEncrypted,
	filterPlainFiles,
	type MigrationFileInfo,
} from '~/crypto'
import i18n from '~/i18n'

export class EncryptionMigrationModal extends Modal {
	private webdav: WebDAVClient
	private remoteBaseDir: string
	private encryptionKey: CryptoKey

	constructor(
		app: App,
		options: {
			webdav: WebDAVClient
			remoteBaseDir: string
			encryptionKey: CryptoKey
		},
	) {
		super(app)
		this.webdav = options.webdav
		this.remoteBaseDir = options.remoteBaseDir
		this.encryptionKey = options.encryptionKey
	}

	async onOpen() {
		const { contentEl } = this
		contentEl.empty()

		this.titleEl.setText('加密迁移')

		contentEl.createEl('p', {
			text: '正在扫描远端文件...',
			cls: 'nutstore-migration-scanning',
		})

		let allFiles: MigrationFileInfo[]
		try {
			allFiles = await detectRemoteFiles(this.webdav, this.remoteBaseDir)
		} catch (e) {
			contentEl.empty()
			contentEl.createEl('p', {
				text: `扫描远端文件失败: ${String(e)}`,
				cls: 'nutstore-encryption-error',
			})
			new Setting(contentEl).addButton((btn) =>
				btn.setButtonText('关闭').onClick(() => this.close()),
			)
			return
		}

		const plainFiles = filterPlainFiles(allFiles)
		const encryptedFiles = allFiles.filter((f) => f.isEncrypted)

		// 重新渲染
		contentEl.empty()

		contentEl.createEl('p', {
			text: `远端文件扫描完成:`,
		})
		contentEl.createEl('ul', undefined, (ul) => {
			ul.createEl('li', { text: `总计: ${allFiles.length} 个文件` })
			ul.createEl('li', { text: `已加密: ${encryptedFiles.length} 个` })
			ul.createEl('li', {
				text: `明文 (需迁移): ${plainFiles.length} 个`,
				cls: plainFiles.length > 0 ? 'nutstore-text-warning' : '',
			})
		})

		if (plainFiles.length === 0) {
			contentEl.createEl('p', {
				text: '✅ 所有远端文件已加密，无需迁移。',
			})
			new Setting(contentEl).addButton((btn) =>
				btn.setButtonText('关闭').onClick(() => this.close()),
			)
			return
		}

		contentEl.createEl('p', {
			text: '迁移过程会下载每个明文文件 → 加密 → 上传覆盖。整个过程在后台执行，请勿关闭 Obsidian。',
			cls: 'nutstore-migration-hint',
		})

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
					.setButtonText('开始迁移')
					.setCta()
					.onClick(async () => {
						if (isRunning) return
						isRunning = true
						btn.setDisabled(true)
						btn.setButtonText('迁移中...')

						progressBar.style.width = '0%'
						progressText.setText(`0 / ${plainFiles.length}`)

						const result = await migrateToEncrypted(
							this.webdav,
							this.remoteBaseDir,
							this.encryptionKey,
							(current, total, filePath) => {
								const pct = Math.round((current / total) * 100)
								progressBar.style.width = `${pct}%`
								progressText.setText(`${current} / ${total} — ${filePath}`)
							},
						)

						contentEl.empty()
						contentEl.createEl('p', {
							text: `迁移完成: 成功 ${result.success} 个, 失败 ${result.failed} 个`,
						})
						if (result.failed === 0) {
							contentEl.createEl('p', { text: '✅ 所有文件已加密。' })
						} else {
							contentEl.createEl('p', {
								text: `⚠️ ${result.failed} 个文件迁移失败，可在下次同步时自动处理。`,
								cls: 'nutstore-text-warning',
							})
						}
						new Setting(contentEl).addButton((btn2) =>
							btn2.setButtonText('关闭').onClick(() => this.close()),
						)
					}),
			)
			.addButton((btn) =>
				btn.setButtonText('跳过').onClick(() => {
					new Notice('明文文件将在下次同步时自动加密上传', 5000)
					this.close()
				}),
			)

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText('取消').onClick(() => this.close()),
		)
	}

	onClose() {
		const { contentEl } = this
		contentEl.empty()
	}
}
