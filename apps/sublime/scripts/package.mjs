#!/usr/bin/env node
/**
 * Zip plugin/ (contents at zip root) into release/MdPreview.sublime-package.
 *
 * Staged via a clean copy so junk (.DS_Store, __pycache__, npm lockfiles,
 * leftover dev-sync state) can never sneak into the archive. Modeled on
 * scripts/package-utools.mjs.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { ZipArchive } from 'archiver'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(__dirname, `..`)
const pluginDir = path.join(pkgRoot, `plugin`)
const releaseDir = path.join(pkgRoot, `release`)

const EXCLUDE_FILES = new Set([`.DS_Store`, `package-lock.json`])
const EXCLUDE_DIRS = new Set([`__pycache__`, `.git`])
const EXCLUDE_SUFFIXES = [`.pyc`, `.pyo`]
// dotfiles are skipped wholesale EXCEPT this ST4 host declaration (Python 3.3 vs 3.8)
const DOTFILE_ALLOWLIST = new Set([`.python-version`])

function shouldKeep(relative) {
  const parts = relative.split(path.sep)
  if (parts.some(part => EXCLUDE_DIRS.has(part)))
    return false
  const base = path.basename(relative)
  if (EXCLUDE_FILES.has(base))
    return false
  return !EXCLUDE_SUFFIXES.some(suffix => base.endsWith(suffix))
}

function stage(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name.startsWith(`.`) && !DOTFILE_ALLOWLIST.has(entry.name))
      continue
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      stage(from, to)
    }
    else if (entry.isFile() && shouldKeep(path.relative(src, from))) {
      fs.copyFileSync(from, to)
    }
  }
}

const pkg = JSON.parse(await readFile(path.join(pkgRoot, `package.json`), `utf8`))
const version = pkg.version

await rm(releaseDir, { recursive: true, force: true })
await mkdir(releaseDir, { recursive: true })

const stagingRoot = path.join(releaseDir, `MdPreview`)
stage(pluginDir, stagingRoot)

// manifest for consumers/debugging
await writeFile(
  path.join(stagingRoot, `renderer`, `VERSION.txt`),
  `doocs-md-sublime ${version}\nbuilt from apps/sublime at ${new Date().toISOString()}\n`,
)

const zipPath = path.join(releaseDir, `MdPreview.sublime-package`)
await new Promise((resolve, reject) => {
  const output = fs.createWriteStream(zipPath)
  const archive = new ZipArchive({ zlib: { level: 9 } })
  output.on(`close`, resolve)
  archive.on(`error`, reject)
  archive.pipe(output)
  archive.directory(stagingRoot, false)
  archive.finalize()
})

await rm(stagingRoot, { recursive: true, force: true })

// --- verify the archive -------------------------------------------------------

const listing = spawnSync(`unzip`, [`-Z1`, zipPath], { encoding: `utf8` })
const entries = listing.status === 0
  ? listing.stdout.split(`\n`).map(line => line.trim()).filter(Boolean)
  : []

function assert(condition, message) {
  if (!condition) {
    console.error(`✗ package verification failed: ${message}`)
    process.exit(1)
  }
}

if (entries.length > 0) {
  assert(entries.includes(`md_preview.py`), `md_preview.py must be at the zip root`)
  assert(
    entries.includes(`renderer/runtime/node_modules/isomorphic-dompurify/package.json`),
    `runtime isomorphic-dompurify must be included`,
  )
  assert(
    entries.includes(`renderer/server.cjs`),
    `renderer bundle must be included`,
  )
  for (const entry of entries) {
    assert(!entry.includes(`__pycache__`) && !entry.endsWith(`.DS_Store`) && !entry.endsWith(`.pyc`), `junk file in archive: ${entry}`)
  }
  console.log(`✔ verified ${entries.length} entries`)
}
else {
  console.warn(`! unzip not available — skipped archive verification`)
}

console.log(`✔ MdPreview package => ${path.relative(pkgRoot, zipPath)} (${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB)`)
