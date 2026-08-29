#!/usr/bin/env node
/**
 * Bundle the preview sidecar into plugin/renderer/server.cjs.
 *
 * Mirrors the two load-bearing tricks from apps/vscode/webpack.config.mjs:
 * - `?raw` imports (asset/source there) → rawLoaderPlugin here, which lets us
 *   import the REAL theme CSS from @md/shared instead of duplicating it like
 *   packages/mcp-server does with fs reads;
 * - isomorphic-dompurify stays external (jsdom is far too heavy to bundle) and
 *   resolves at runtime from plugin/renderer/runtime/node_modules, installed by
 *   copy-runtime-deps.mjs — the relative require resolves against server.cjs,
 *   so the whole plugin/ tree can be copied anywhere (Sublime Packages dir, zip).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(__dirname, `..`)
const outfile = path.join(pkgRoot, `plugin`, `renderer`, `server.cjs`)

const rawLoaderPlugin = {
  name: `md-raw-loader`,
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, args => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, ``)),
      namespace: `md-raw`,
    }))
    build.onLoad({ filter: /.*/, namespace: `md-raw` }, args => ({
      contents: fs.readFileSync(args.path, `utf8`),
      loader: `text`,
    }))
  },
}

const runtimeExternalPlugin = {
  name: `md-runtime-external`,
  setup(build) {
    build.onResolve({ filter: /^isomorphic-dompurify$/ }, () => ({
      path: `./runtime/node_modules/isomorphic-dompurify`,
      external: true,
    }))
  },
}

await esbuild.build({
  entryPoints: [path.join(pkgRoot, `renderer/src/main.ts`)],
  outfile,
  bundle: true,
  platform: `node`,
  format: `cjs`,
  target: `node20`,
  sourcemap: false,
  legalComments: `none`,
  logLevel: `info`,
  plugins: [rawLoaderPlugin, runtimeExternalPlugin],
})

// Guard: the emitted require must be the relative runtime path, not an
// absolute build-machine path (which would break on any other machine).
const bundle = fs.readFileSync(outfile, `utf8`)
if (!bundle.includes(`./runtime/node_modules/isomorphic-dompurify`)) {
  throw new Error(
    `esbuild did not emit the expected relative require for isomorphic-dompurify — `
    + `switch to a .cjs shim module (see renderer/src) instead of the runtimeExternalPlugin`,
  )
}

// Vendor the EXACT mermaid version the workspace uses — the preview page
// hydrates diagrams with it (served by the sidecar at /vendor/mermaid.mjs), so
// browser rendering matches md.doocs.org, which bundles the same version.
// mermaid is a transitive dep (of @md/core), so resolve through core's real
// node_modules (pnpm keeps per-package symlinks there).
const { createRequire } = await import(`node:module`)
const requireFromPkg = createRequire(path.join(pkgRoot, `package.json`))
const mermaidDist = `dist/mermaid.esm.min.mjs`
const candidates = []
for (const base of [path.join(pkgRoot, `node_modules`), fs.realpathSync(path.join(pkgRoot, `node_modules`, `@md`, `core`, `node_modules`))]) {
  candidates.push(path.join(base, `mermaid`, mermaidDist))
}
try {
  candidates.unshift(requireFromPkg.resolve(`mermaid/${mermaidDist}`))
}
catch {
  // exports map blocks the subpath — the path candidates cover it
}
const mermaidEntry = candidates.find(candidate => fs.existsSync(candidate))
if (!mermaidEntry)
  throw new Error(`mermaid ${mermaidDist} not found — expected it via @md/core's node_modules`)
const vendorDir = path.join(pkgRoot, `plugin`, `renderer`, `vendor`)
fs.rmSync(vendorDir, { recursive: true, force: true })
fs.mkdirSync(vendorDir, { recursive: true })
fs.copyFileSync(mermaidEntry, path.join(vendorDir, `mermaid.mjs`))
// mermaid.esm.min.mjs is code-split — its chunk imports are relative, so the
// chunks tree must sit next to the entry at the same relative depth
const chunksDir = path.join(path.dirname(mermaidEntry), `chunks`)
if (fs.existsSync(chunksDir)) {
  fs.cpSync(chunksDir, path.join(vendorDir, `chunks`), {
    recursive: true,
    filter: source => !source.endsWith(`.map`),
  })
}
const vendoredBytes = fs.readdirSync(path.join(vendorDir, `chunks`), { recursive: true, withFileTypes: true })
  .filter(e => e.isFile())
  .length
console.log(`✓ vendored mermaid => ${path.relative(pkgRoot, path.join(vendorDir, `mermaid.mjs`))} (+${vendoredBytes} chunks)`)

console.log(`✓ renderer bundle => ${path.relative(pkgRoot, outfile)}`)
