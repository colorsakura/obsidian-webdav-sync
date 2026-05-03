import postcss from '@deanc/esbuild-plugin-postcss'
import dotenv from 'dotenv'
import esbuild from 'esbuild'
import fs, { readFileSync } from 'fs'
import postcssMergeRules from 'postcss-merge-rules'
import process from 'process'

const pkgJson = JSON.parse(readFileSync('./package.json', 'utf-8'))
dotenv.config()

const prod = process.argv[2] === 'production'

const renamePlugin = {
	name: 'rename-plugin',
	setup(build) {
		build.onEnd(async () => {
			fs.renameSync('./main.css', './styles.css')
		})
	},
}

const copyWasmPlugin = {
	name: 'copy-wasm-plugin',
	setup(build) {
		build.onEnd(async () => {
			fs.copyFileSync(
				'./node_modules/sql.js/dist/sql-wasm-browser.wasm',
				'./sql-wasm-browser.wasm',
			)
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
		renamePlugin,
			copyWasmPlugin,
	],
})

if (prod) {
	await context.rebuild()
	process.exit(0)
} else {
	await context.watch()
}
