/**
 * Mock for obsidian module
 *
 * Provides minimal API surface needed for tests
 */

export const Platform = {
  isDesktopApp: true,
  isMobileApp: false,
  isMacOS: false,
  isWin: false,
  isLinux: true,
  isAndroidApp: false,
  isIosApp: false,
}

export class Modal {
  app: any
  titleEl: HTMLElement
  contentEl: HTMLElement

  constructor(app: any) {
    this.app = app
    this.titleEl = document.createElement('div')
    this.contentEl = document.createElement('div')
  }

  open() {}
  close() {}
}

export class Notice {
  constructor(message: string, duration?: number) {}
}

export class Setting {
  constructor(containerEl: HTMLElement) {
    // No-op in tests
  }
  setName(name: string) { return this }
  setDesc(desc: string) { return this }
  setHeading() { return this }
  addToggle(cb: Function) { return this }
  addText(cb: Function) { return this }
  addButton(cb: Function) { return this }
  addComponent(cb: Function) { return this }
}

export class PluginSettingTab {
  app: any
  plugin: any
  containerEl: HTMLElement

  constructor(app: any, plugin: any) {
    this.app = app
    this.plugin = plugin
    this.containerEl = document.createElement('div')
  }
}

export const normalizePath = (path: string) => path

export function requireApiVersion(version: string): boolean {
  return true
}

export const moment = (date?: any) => ({
  format: (fmt: string) => '',
})

export interface Vault {
  adapter: any
  getName(): string
  configDir: string
}

export interface App {
  vault: Vault
  secretStorage: {
    setSecret: (id: string, value: string) => Promise<void>
    getSecret: (id: string) => Promise<string | null>
  }
}
