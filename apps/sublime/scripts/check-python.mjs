#!/usr/bin/env node
/** Syntax-check every plugin .py file with the system python3 (ast.parse only — no imports, no .pyc). */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(__dirname, `..`, `plugin`)

function collect(dir, into = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(`.`))
      continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory())
      collect(full, into)
    else if (entry.name.endsWith(`.py`))
      into.push(full)
  }
  return into
}

const files = collect(pluginDir)
if (files.length === 0) {
  console.error(`no .py files found under ${pluginDir}`)
  process.exit(1)
}

const program = `
import ast, pathlib, sys
failed = False
for name in sys.argv[1:]:
    source = pathlib.Path(name).read_text(encoding='utf-8')
    try:
        ast.parse(source, filename=name)
        print(f'  ok {name}')
    except SyntaxError as err:
        failed = True
        print(f'  FAIL {name}: {err}')
sys.exit(1 if failed else 0)
`

for (const binary of [`python3`, `python`]) {
  const result = spawnSync(binary, [`-c`, program, ...files], { encoding: `utf8` })
  if (result.error)
    continue
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  if (result.status === 0) {
    console.log(`check-python: ${files.length} file(s) parsed cleanly (${binary})`)
    process.exit(0)
  }
  console.error(`check-python: syntax errors found`)
  process.exit(1)
}

console.error(`check-python: neither python3 nor python is available on PATH`)
process.exit(1)
