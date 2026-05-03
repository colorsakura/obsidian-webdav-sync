# Migrate to TypeScript-Go (tsgo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Node.js `tsc` with Go-native `tsgo` for type checking, adapt tsconfig for TypeScript 7.

**Architecture:** tsgo handles `--noEmit` type checking (~10x faster); esbuild continues handling bundling, postcss, wasm inlining, and minification unchanged. The two tools serve distinct roles and share no configuration.

**Tech Stack:** @typescript/native-preview (tsgo), esbuild, bun

---

### Task 1: Install tsgo and update tsconfig

**Files:**
- Modify: `tsconfig.json`
- Modify: `package.json` (scripts section only)

- [ ] **Step 1: Install @typescript/native-preview**

```bash
bun add -D @typescript/native-preview@beta
```

- [ ] **Step 2: Update tsconfig.json for TypeScript 7 compatibility**

```json
{
  "compilerOptions": {
    "inlineSourceMap": true,
    "inlineSources": true,
    "module": "ESNext",
    "target": "ES2022",
    "allowJs": true,
    "noImplicitAny": true,
    "moduleResolution": "bundler",
    "importHelpers": true,
    "isolatedModules": true,
    "strictNullChecks": true,
    "allowSyntheticDefaultImports": true,
    "lib": ["DOM", "ES2022"],
    "paths": {
      "~/*": ["./src/*"],
      "~": ["./src"]
    }
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules", "**/*.test.ts", "__mocks__"]
}
```

Changes from current:
- Remove `baseUrl` (removed in TS7)
- Remove `ignoreDeprecations` (TS6-specific)
- `target`: `ES6` → `ES2022`
- `lib`: `["DOM", "ES5", "ES6", "ES7"]` → `["DOM", "ES2022"]`

- [ ] **Step 3: Update package.json scripts**

Replace the `build:plugin` script and add `typecheck`:

```json
"build:plugin": "tsgo --noEmit && bun esbuild.config.mjs production",
```

Add after the `build:plugin` line:

```json
"typecheck": "tsgo --noEmit",
```

- [ ] **Step 4: Commit**

```bash
git add tsconfig.json package.json bun.lock
git commit -m "$(cat <<'EOF'
build: migrate to tsgo for type checking

Replace tsc with @typescript/native-preview (tsgo). Adapt tsconfig
for TypeScript 7: remove baseUrl, upgrade target to ES2022, drop
deprecated lib entries.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Verify the migration

**Files:** None (verification only)

- [ ] **Step 1: Run tsgo type check**

```bash
bun x tsgo --noEmit
```

Expected: Zero errors, exit code 0.

- [ ] **Step 2: Run production build**

```bash
bun run build:plugin
```

Expected: Build succeeds, `main.js` and `styles.css` generated.

- [ ] **Step 3: Run test suite**

```bash
bun test
```

Expected: All tests pass.

- [ ] **Step 4: Commit (if any fixes were needed)**

Only needed if Steps 1-3 required changes:
```bash
git add <changed files>
git commit -m "fix: address tsgo strict issues"
```

---

### Task 3: CI / automation compatibility check

**Files:**
- Review: `.github/workflows/` (if exists)

- [ ] **Step 1: Check if CI uses tsc directly**

```bash
grep -r "tsc" .github/ 2>/dev/null || echo "No .github directory found"
```

If CI scripts reference `tsc`, update them to `tsgo`.

- [ ] **Step 2: If CI exists, update and commit**

```bash
git add .github/workflows/
git commit -m "ci: switch type checking to tsgo"
```

If no CI references found, skip this commit.

---

### Task 4: Final validation and summary

- [ ] **Step 1: Diff main.js against pre-migration build**

```bash
# Stash current changes, build with old tsc, save main.js
git stash
bun run build:plugin
cp main.js /tmp/main.js.old
# Restore changes, build with tsgo
git stash pop
bun run build:plugin
diff <(xxd /tmp/main.js.old) <(xxd main.js) | head -20
```

Expected: No diff (identical output). If minor differences appear (e.g., timestamp variations in source maps), note them but they're acceptable.

- [ ] **Step 2: Final commit (if any remaining changes)**

Only if Step 1 revealed issues.
