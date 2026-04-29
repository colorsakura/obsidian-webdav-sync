/**
 * 共用密码恢复 Modal
 *
 * 用于同步前置检测和设置页面的密钥恢复场景。
 * 用户输入密码 → 调用 restoreEncryption → 返回结果。
 */

import { App, Modal, Setting } from 'obsidian'
import type { EncryptionSettings } from './types'
import { restoreEncryption } from './key-store'

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

        new Setting(contentEl).setName('密码').addText((text) => {
            text.inputEl.type = 'password'
            text.inputEl.placeholder = '输入加密密码'
            passwordInput = text.inputEl
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
                        const success = await restoreEncryption(
                            app,
                            password,
                            encryption,
                        )
                        if (!success) {
                            errorEl.setText('密码错误，请重试')
                            errorEl.style.display = 'block'
                            btn.setDisabled(false)
                            btn.setButtonText('确认')
                            return
                        }
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
