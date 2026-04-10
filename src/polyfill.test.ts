import { afterEach, describe, expect, it, vi } from 'vitest'

const originalProcess = globalThis.process

afterEach(() => {
	globalThis.process = originalProcess
	vi.resetModules()
})

describe('polyfill', () => {
	it('adds process.env when it is missing', async () => {
		;(globalThis as typeof globalThis & { process: any }).process = {
			cwd() {
				return '/mobile'
			},
		}

		vi.resetModules()
		await import('./polyfill')

		expect(globalThis.process).toBeDefined()
		expect(typeof globalThis.process.cwd).toBe('function')
		expect(globalThis.process.cwd()).toBe('/mobile')
		expect(globalThis.process.env).toEqual({})
	})
})
