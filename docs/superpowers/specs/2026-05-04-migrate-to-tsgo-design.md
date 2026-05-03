# Migrate to TypeScript-Go (tsgo)

## Goal

Replace the Node.js-based `tsc` with Microsoft's Go-native `tsgo` (`@typescript/native-preview`) for type checking, while keeping esbuild as the bundler.

## Motivation

tsgo is ~10x faster than tsc. The current `tsc -noEmit` step runs on every build; replacing it with tsgo cuts CI/build time significantly with zero functional change to the plugin output.

## Scope

- Replace `tsc` with `tsgo` for type checking
- Adapt tsconfig.json for TypeScript 7 compatibility
- No changes to source code, esbuild config, or vitest config

## Design Decisions

### 1. tsgo for type checking only, esbuild stays for bundling

esbuild handles postcss, wasm inlining, minification, and platform polyfills. tsgo cannot replace these. Keep esbuild as the bundler, use tsgo only for `--noEmit` type checking.

### 2. Keep `~` path aliases, remove only `baseUrl`

`baseUrl` is removed in TS7. `paths` still works — values resolve relative to tsconfig.json's directory. The existing `"~/*": ["./src/*"]` is compatible as-is.

esbuild and vitest both resolve `~` independently (esbuild via its own alias, vitest via `path.resolve` in vitest.config.ts), so this removal has no downstream impact.

### 3. Upgrade target and lib to match TS7 minimums

TS7 drops `ES5`/`ES6`/`ES7` targets and lib entries. The minimum target is `ES2022`. esbuild already targets `es2023`, so this aligns the type-check target with the actual output target.

### 4. Strict mode is now default (no-op for this project)

TS7 forces `strict: true`. The project already passes full strict checks with zero errors, confirmed by running `tsc --strict` against the current codebase.

## Changes

### tsconfig.json

```diff
{
  "compilerOptions": {
-   "baseUrl": ".",
-   "ignoreDeprecations": "6.0",
-   "target": "ES6",
-   "lib": ["DOM", "ES5", "ES6", "ES7"],
+   "target": "ES2022",
+   "lib": ["DOM", "ES2022"],
    "paths": { "~/*": ["./src/*"], "~": ["./src"] },
    // unchanged: module, moduleResolution, importHelpers, etc.
  }
}
```

### package.json scripts

```diff
-"build:plugin": "tsc -noEmit -skipLibCheck && bun esbuild.config.mjs production",
+"build:plugin": "tsgo --noEmit && bun esbuild.config.mjs production",
+"typecheck": "tsgo --noEmit",
```

### New devDependency

Install `@typescript/native-preview` (provides the `tsgo` binary).

## What Stays the Same

- esbuild.config.mjs — no changes
- vitest.config.ts — no changes
- All 144 source files — no changes
- esbuild watch mode for dev — no changes
- All path alias imports (`~/`) — no changes

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| tsgo paths resolution differs from tsc | Low | Verified paths syntax is compatible; fallback: relative imports |
| tsgo strict finds errors tsc didn't | Very Low | `tsc --strict` already passes with zero errors |
| tsgo watch instability | N/A | Won't use tsgo watch; keep esbuild watch |

## Verification

1. `tsgo --noEmit` passes with zero errors
2. `bun esbuild.config.mjs production` produces identical main.js
3. `bun test` passes all vitest suites
