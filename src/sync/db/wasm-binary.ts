// Import the WASM binary as base64.
// In Node.js / Bun (vitest): reads directly from disk.
// In browser (esbuild): replaced by inlineWasmPlugin.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dir = dirname(__filename)
const wasmPath = resolve(
	__dir,
	'../../../node_modules/sql.js/dist/sql-wasm-browser.wasm',
)
const buffer = readFileSync(wasmPath)
const base64 = buffer.toString('base64')

export default base64
