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

console.log(`✓ renderer bundle => ${path.relative(pkgRoot, outfile)}`)
