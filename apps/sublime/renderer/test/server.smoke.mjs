#!/usr/bin/env node
/**
 * Server smoke test — spawns the bundled sidecar, reads the MDP1 startup line,
 * and walks the whole HTTP protocol. This also proves the relative
 * `./runtime/node_modules/isomorphic-dompurify` require resolved (the server
 * cannot even finish booting without it).
 */
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(__dirname, `..`, `..`)
const serverCjs = path.join(pkgRoot, `plugin`, `renderer`, `server.cjs`)

if (!fs.existsSync(serverCjs)) {
  console.error(`server.cjs not found — run "npm run build" first`)
  process.exit(1)
}

const STARTUP_TIMEOUT_MS = 60_000

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

function request(port, method, requestPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), `utf8`)
    const req = http.request(
      {
        host: `127.0.0.1`,
        port,
        method,
        path: requestPath,
        headers: {
          ...(payload ? { 'Content-Type': `application/json`, 'Content-Length': payload.length } : {}),
          ...headers,
        },
        timeout: 120_000,
      },
      (res) => {
        const chunks = []
        res.on(`data`, chunk => chunks.push(chunk))
        res.on(`end`, () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(`utf8`) }))
      },
    )
    req.on(`timeout`, () => req.destroy(new Error(`request timed out`)))
    req.on(`error`, reject)
    if (payload)
      req.write(payload)
    req.end()
  })
}

function main() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverCjs], {
      stdio: [`ignore`, `pipe`, `pipe`],
      env: { ...process.env, MD_IDLE_SECONDS: `1800` },
    })

    let stderr = ``
    child.stderr.on(`data`, chunk => stderr += chunk)

    const startupTimer = setTimeout(() => {
      reject(new Error(`timed out waiting for MDP1 line. stderr:\n${stderr}`))
      child.kill(`SIGKILL`)
    }, STARTUP_TIMEOUT_MS)

    let buffer = ``
    child.stdout.on(`data`, (chunk) => {
      buffer += chunk
      const newlineIndex = buffer.indexOf(`\n`)
      if (newlineIndex === -1)
        return
      clearTimeout(startupTimer)
      const line = buffer.slice(0, newlineIndex).trim()
      const match = /^MDP1 (\d+) ([0-9a-f]+)$/.exec(line)
      if (!match) {
        reject(new Error(`unexpected startup line: ${JSON.stringify(line)}`))
        child.kill(`SIGKILL`)
        return
      }
      resolve({ child, port: Number(match[1]), token: match[2] })
    })
  })
}

async function run() {
  const { child, port, token } = await main()
  const auth = { 'X-MD-Token': token }
  console.log(`server.smoke: sidecar on 127.0.0.1:${port}`)

  try {
    let res = await request(port, `GET`, `/health`)
    check(`health ok`, res.status === 200 && JSON.parse(res.body).ok === true, res.body)

    res = await request(port, `POST`, `/render`, {
      headers: auth,
      body: { id: `smoke-1`, markdown: `# 你好\n\n世界`, title: `Smoke 测试`, pollMs: 500 },
    })
    const renderBody = JSON.parse(res.body)
    check(`render ok`, res.status === 200 && renderBody.ok === true, res.body)
    check(`first rev is 1`, renderBody.rev === 1, renderBody.rev)
    check(`preview url returned`, typeof renderBody.url === `string` && renderBody.url.startsWith(`/p/`), renderBody.url)

    const docRes = await request(port, `GET`, renderBody.url)
    check(`preview document served`, docRes.status === 200 && docRes.body.startsWith(`<!DOCTYPE html>`))
    check(`poller injected with rev`, docRes.body.includes(`var REV = 1`) && docRes.body.includes(`setInterval`))
    check(`cjk content intact`, docRes.body.includes(`你好`) && docRes.body.includes(`世界`))
    check(`default adaptive pc-width layout`, docRes.body.includes(`max-width: 960px`))

    res = await request(port, `POST`, `/render`, {
      headers: auth,
      body: { id: `smoke-width`, markdown: `# 宽度`, previewWidth: 375 },
    })
    const narrowDoc = await request(port, `GET`, JSON.parse(res.body).url)
    check(`previewWidth 375 fixed column`, narrowDoc.body.includes(`width: 375px`) && !narrowDoc.body.includes(`max-width: 960px`))

    const slug = renderBody.url.slice(`/p/`.length)
    res = await request(port, `GET`, `/version/${slug}`)
    check(`version endpoint`, res.status === 200 && JSON.parse(res.body).rev === 1, res.body)

    res = await request(port, `POST`, `/render`, {
      headers: auth,
      body: { id: `smoke-1`, markdown: `# 更新\n\n第二次`, title: `Smoke 测试`, pollMs: 500 },
    })
    check(`second rev is 2`, JSON.parse(res.body).rev === 2, res.body)

    res = await request(port, `GET`, `/version/${slug}`)
    check(`version bumped`, JSON.parse(res.body).rev === 2, res.body)

    res = await request(port, `GET`, renderBody.url)
    check(`document re-rendered`, res.body.includes(`更新`) && res.body.includes(`var REV = 2`))
    check(`slug stable across renders`, res.body.includes(`SLUG = "${slug}"`))

    res = await request(port, `POST`, `/render`, {
      headers: { 'X-MD-Token': `deadbeef` },
      body: { id: `smoke-1`, markdown: `x` },
    })
    check(`bad token rejected`, res.status === 401, res.status)

    res = await request(port, `POST`, `/render`, {
      headers: auth,
      body: { id: `bad id with spaces!`, markdown: `x` },
    })
    check(`invalid id rejected`, res.status === 400, res.status)

    res = await request(port, `POST`, `/render`, {
      headers: auth,
      body: { id: `smoke-2`, markdown: `x`, options: { theme: `nope` } },
    })
    check(`invalid options rejected`, res.status === 400, res.status)

    res = await request(port, `GET`, `/p/unknown-slug`)
    check(`unknown slug 404`, res.status === 404, res.status)

    // oversized body → 413 (server destroys the socket; a client error is expected)
    let oversizeStatus = `no-error`
    try {
      const big = `x`.repeat(9 * 1024 * 1024)
      await request(port, `POST`, `/render`, { headers: auth, body: { id: `smoke-3`, markdown: big } })
      oversizeStatus = `completed`
    }
    catch {
      oversizeStatus = `connection-reset`
    }
    check(`oversized body rejected`, oversizeStatus !== `completed`, oversizeStatus)

    // server still healthy afterwards
    res = await request(port, `GET`, `/health`)
    check(`healthy after abuse`, res.status === 200, res.status)

    res = await request(port, `POST`, `/render`, {
      headers: auth,
      body: { id: `smoke-1`, markdown: `# 最终`, returnHtml: true },
    })
    check(`returnHtml honored`, typeof JSON.parse(res.body).html === `string` && JSON.parse(res.body).html.includes(`<section`), res.body.slice(0, 200))

    res = await request(port, `POST`, `/shutdown`, { headers: auth })
    check(`shutdown accepted`, res.status === 200 && JSON.parse(res.body).ok === true, res.body)

    const exitCode = await new Promise(resolve => child.on(`exit`, resolve))
    check(`process exited cleanly`, exitCode === 0, exitCode)
  }
  finally {
    child.kill(`SIGKILL`)
  }

  if (failures > 0) {
    console.error(`\nserver.smoke: ${failures} failure(s)`)
    process.exit(1)
  }
  console.log(`\nserver.smoke: all checks passed`)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
