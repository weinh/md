#!/usr/bin/env node
/**
 * Render smoke test — exercises the BUNDLED sidecar via --render-file mode and
 * asserts on the produced document. This intentionally goes through
 * plugin/renderer/server.cjs (not tsx on the TS sources) because the sources
 * import theme CSS via Vite-style `?raw` specifiers that only the esbuild
 * rawLoaderPlugin can resolve.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(__dirname, `..`, `..`)
const serverCjs = path.join(pkgRoot, `plugin`, `renderer`, `server.cjs`)
const fixture = path.join(__dirname, `fixture.md`)

if (!fs.existsSync(serverCjs)) {
  console.error(`server.cjs not found — run "npm run build" first`)
  process.exit(1)
}

function render(extraArgs = []) {
  return execFileSync(process.execPath, [serverCjs, `--render-file`, fixture, ...extraArgs], {
    encoding: `utf8`,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  })
}

function renderRaw(markdown, options) {
  const file = path.join(__dirname, `.tmp-input.md`)
  fs.writeFileSync(file, markdown)
  const optFile = path.join(__dirname, `.tmp-options.json`)
  fs.writeFileSync(optFile, JSON.stringify(options ?? {}))
  try {
    return execFileSync(
      process.execPath,
      [serverCjs, `--render-file`, file, `--options-file`, optFile],
      { encoding: `utf8`, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
    )
  }
  finally {
    fs.rmSync(file, { force: true })
    fs.rmSync(optFile, { force: true })
  }
}

let failures = 0
function check(name, condition, actual) {
  if (condition) {
    console.log(`  ✓ ${name}`)
  }
  else {
    failures++
    console.error(`  ✗ ${name}${actual ? ` — got: ${String(actual).slice(0, 200)}` : ``}`)
  }
}

const doc = render()
fs.writeFileSync(path.join(__dirname, `fixture.actual.html`), doc)

console.log(`render.smoke: default options`)
check(`full document wrapper`, doc.startsWith(`<!DOCTYPE html>`) && doc.includes(`</html>`))
check(`charset meta`, doc.includes(`<meta charset="utf-8">`))
check(`adaptive pc-width preview card`, doc.includes(`.md-preview-card`) && doc.includes(`max-width: 960px`))
check(`container section`, doc.includes(`<section class="container">`))
check(`shell css variables`, doc.includes(`--foreground:`) && doc.includes(`--blockquote-background:`))
check(`default primary color`, doc.includes(`#0F4C81`))
check(`mac code block sign`, doc.includes(`mac-sign`) && doc.includes(`display: flex`))
check(`syntax highlighting applied`, doc.includes(`hljs`))
check(`table rendered`, doc.includes(`<th`) && doc.includes(`<td`))
check(`blockquote rendered`, doc.includes(`<blockquote`))
check(`front-matter stripped from body`, !doc.includes(`author: doocs`))
check(`math as MathML`, doc.includes(`Math/MathML`) && doc.includes(`<mi>`))
check(`mermaid diagrams inlined as svg`, (doc.match(/class="mermaid-diagram"><svg/g) ?? []).length >= 2, doc.match(/mermaid-diagram[^>]*/g)?.slice(0, 2))
check(`no mermaid placeholders left`, !doc.includes(`data-md-diagram-state="loading"`))
check(`footnote present`, doc.includes(`footnote`))
check(`no poller in one-shot mode`, !doc.includes(`setInterval`))

console.log(`render.smoke: options variations`)
const inline = renderRaw(`# 标题\n\n一段文字。`, { inlineStyles: true })
check(`juice inlining produces style attributes`, inline.includes(`style=`), inline.slice(0, 300))
check(`juice inlining drops <style> block`, !/<style>[\s\S]*--foreground/.test(inline))

const counted = renderRaw(`# 标题\n\n正文内容若干字。`, { countStatus: true })
check(`countStatus adds reading stats`, /阅读|字数|分钟/.test(counted), counted.match(/<section[^>]*>[\s\S]{0,200}/)?.[0])

const grace = renderRaw(`# 标题\n`, { theme: `grace` })
const defaultTheme = renderRaw(`# 标题\n`, { theme: `default` })
check(`theme grace differs from default`, grace !== defaultTheme)

const noMac = renderRaw('```js\nconst a = 1\n```\n', { isMacCodeBlock: false })
check(`isMacCodeBlock=false hides mac sign`, !noMac.includes(`mac-sign`) || noMac.includes(`display: none`))

const narrow = renderRaw(`# 标题\n`, { previewWidth: 375 })
check(`previewWidth 375 fixed column`, narrow.includes(`width: 375px`) && !narrow.includes(`max-width: 960px`))
const bogusWidth = renderRaw(`# 标题\n`, { previewWidth: 12 })
check(`previewWidth out of range falls back to adaptive`, bogusWidth.includes(`max-width: 960px`) && !bogusWidth.includes(`width: 12px`))

if (failures > 0) {
  console.error(`\nrender.smoke: ${failures} failure(s)`)
  process.exit(1)
}
console.log(`\nrender.smoke: all checks passed`)
