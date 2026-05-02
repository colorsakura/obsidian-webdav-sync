import type { App } from 'obsidian'
import type { NutstoreSettingTab } from '.'
import type NutstorePlugin from '..'

export default abstract class BaseSettings {
	constructor(
		protected app: App,
		protected plugin: NutstorePlugin,
		protected settings: NutstoreSettingTab,
		protected containerEl: HTMLElement,
	) {}

	abstract display(): void
}
