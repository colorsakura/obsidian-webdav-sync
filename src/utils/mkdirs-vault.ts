import type { Vault } from 'obsidian'
import { dirname, normalize } from 'path-browserify'

export async function mkdirsVault(vault: Vault, path: string) {
	const stack: string[] = []
	let currentPath = normalize(path)
	if (currentPath === '/' || currentPath === '.') {
		return
	}
	if (await vault.adapter.exists(currentPath)) {
		return
	}
	while (
		currentPath !== '' &&
		currentPath !== '/' &&
		currentPath !== '.' &&
		!(await vault.adapter.exists(currentPath))
	) {
		stack.push(currentPath)
		currentPath = dirname(currentPath)
	}
	while (stack.length) {
		const pop = stack.pop()
		if (!pop) {
			continue
		}
		if (await vault.adapter.exists(pop)) {
			continue
		}
		await vault.adapter.mkdir(pop)
	}
}
