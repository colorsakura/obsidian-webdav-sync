import postcss from '@deanc/esbuild-plugin-postcss'
import dotenv from 'dotenv'
import esbuild from 'esbuild'
import fs, { readFileSync } from 'fs'
import postcssMergeRules from 'postcss-merge-rules'
import process from 'process'

const pkgJson = JSON.parse(readFileSync('./package.json', 'utf-8'))
dotenv.config()

const prod = process.argv[2] === 'production'

// Read sql.js WASM binary and encode as base64 for inline bundling
const wasmBase64 = readFileSync(
	'./node_modules/sql.js/dist/sql-wasm-browser.wasm',
).toString('base64')

// Replace the wasm-binary.ts module with inlined base64 at build time
const inlineWasmPlugin = {
	name: 'inline-wasm-plugin',
	setup(build) {
		build.onResolve(
			{ filter: /wasm-binary$/ },
			(args) => ({ path: args.path, namespace: 'wasm-inline' }),
		)
		build.onLoad(
			{ filter: /.*/, namespace: 'wasm-inline' },
			() => ({
				contents: `export default ${JSON.stringify(wasmBase64)}`,
				loader: 'js',
			}),
		)
	},
}

const renamePlugin = {
	name: 'rename-plugin',
	setup(build) {
		build.onEnd(async () => {
			fs.renameSync('./main.css', './styles.css')
		})
	},
}

const context = await esbuild.context({
	entryPoints: ['src/index.ts'],
	bundle: true,
	external: [
		'obsidian',
		'electron',
		'@codemirror/autocomplete',
		'@codemirror/collab',
		'@codemirror/commands',
		'@codemirror/language',
		'@codemirror/lint',
		'@codemirror/search',
		'@codemirror/state',
		'@codemirror/view',
		'@lezer/common',
		'@lezer/highlight',
		'@lezer/lr',
	],
	define: {
		'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || ''),
		'process.env.PLUGIN_VERSION': JSON.stringify(pkgJson.version),
	},
	format: 'cjs',
	target: 'es2023',
	logLevel: 'info',
	sourcemap: prod ? false : 'inline',
	treeShaking: true,
	outfile: 'main.js',
	minify: prod,
	platform: 'browser',
	plugins: [
		postcss({
			plugins: [postcssMergeRules()],
		}),
		inlineWasmPlugin,
		renamePlugin,
	],
})

if (prod) {
	await context.rebuild()
	process.exit(0)
} else {
	await context.watch()
}
