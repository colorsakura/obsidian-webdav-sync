import path from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '~': path.resolve(__dirname, './src'),
      'obsidian': path.resolve(__dirname, './__mocks__/obsidian.ts'),
    },
  },
  test: {
    testTimeout: 30000,
  },
})
