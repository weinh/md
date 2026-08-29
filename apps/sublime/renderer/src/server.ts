import type { AddressInfo } from 'node:net'
import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { buildPreviewDocument } from './document'
import { ValidationError } from './options'
import { buildPreviewOutput } from './render'

/**
 * Preview sidecar: a plain node:http server bound to 127.0.0.1 only.
 *
 * The Sublime plugin spawns `node server.cjs`, reads the one-line startup
 * protocol from stdout (`MDP1 <port> <token>`), and talks JSON over HTTP:
 *
 *   GET  /health          liveness probe (no auth)
 *   POST /render          auth: X-MD-Token — {id, markdown, options, returnHtml?}
 *   GET  /p/:slug         the full preview document (slug is the secret)
 *   GET  /version/:slug   {rev} — polled by the in-page refresh script
 *   POST /shutdown        auth: X-MD-Token — graceful exit
 *
 * The port is kernel-assigned (listen on 0) so there are never collisions.
 */

// keep in sync with apps/sublime/package.json "version"
const VERSION = '0.1.0'

const MAX_BODY_BYTES = 8 * 1024 * 1024
const DEFAULT_IDLE_SECONDS = 1800

const idleSeconds = Number.parseInt(process.env.MD_IDLE_SECONDS ?? '', 10) || DEFAULT_IDLE_SECONDS
const token = crypto.randomBytes(24).toString('hex')

interface DocEntry {
  slug: string
  documentHtml: string
  rev: number
}

interface RenderRequestBody {
  id: string
  markdown: string
  options?: unknown
  returnHtml?: boolean
  title?: string
  pollMs?: number
  previewWidth?: number | string
}

interface RenderResult {
  rev: number
  url: string
  warnings: string[]
  html?: string
}

const docs = new Map<string, DocEntry>()
const docsBySlug = new Map<string, DocEntry>()

// --- latest-wins render queue, keyed by doc id --------------------------------
// Renders are CPU-bound; rapid saves must not queue a stale backlog. Each POST
// stores its body as the pending input for its id; a single serialized chain
// per id always renders the newest pending body and resolves all waiters.

const pendingBodies = new Map<string, RenderRequestBody>()
const renderChains = new Map<string, Promise<RenderResult>>()
const lastResults = new Map<string, RenderResult>()

function submitRender(body: RenderRequestBody): Promise<RenderResult> {
  pendingBodies.set(body.id, body)
  const previous = renderChains.get(body.id) ?? Promise.resolve({ rev: 0, url: '', warnings: [] })
  const next = previous.catch(() => undefined).then(async () => {
    const input = pendingBodies.get(body.id)
    pendingBodies.delete(body.id)
    if (!input)
      return lastResults.get(body.id)!
    const result = await performRender(input)
    lastResults.set(body.id, result)
    return result
  })
  renderChains.set(body.id, next)
  return next
}

async function performRender(body: RenderRequestBody): Promise<RenderResult> {
  const pollMs = Number.isFinite(body.pollMs) && (body.pollMs ?? 0) > 0 ? body.pollMs! : 800
  const title = (body.title ?? 'Md Preview').slice(0, 200)
  const width = sanitizePreviewWidth(body.previewWidth)
  // browser previews hydrate mermaid client-side (exact md.doocs.org parity);
  // returnHtml (WeChat copy) needs the server-rendered inline SVG
  const output = await buildPreviewOutput(body.markdown, body.options, { serverMermaid: Boolean(body.returnHtml) })

  const previous = docs.get(body.id)
  const rev = (previous?.rev ?? 0) + 1
  const slug = previous?.slug ?? `${sanitizeSlug(body.id)}-${crypto.randomBytes(4).toString('hex')}`

  const themeMode = body.options && typeof body.options === 'object' && (body.options as { themeMode?: unknown }).themeMode === 'dark'
    ? 'dark'
    : undefined

  const entry: DocEntry = {
    slug,
    documentHtml: buildPreviewDocument(output.html, { slug, rev, pollMs, title, width, mermaidTheme: themeMode }),
    rev,
  }
  docs.set(body.id, entry)
  docsBySlug.set(slug, entry)

  return {
    rev,
    url: `/p/${slug}`,
    warnings: output.warnings,
    html: body.returnHtml ? output.html : undefined,
  }
}

function sanitizeSlug(id: string): string {
  const cleaned = id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 64)
  return cleaned.length > 0 ? cleaned : 'doc'
}

/** 'adaptive' passes through; numbers outside [200, 4096] fall back to it (mirrors preview_width_value in Python). */
function sanitizePreviewWidth(raw: number | string | undefined): 'adaptive' | number {
  if (raw === undefined || raw === 'adaptive')
    return 'adaptive'
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 200 || value > 4096)
    return 'adaptive'
  return Math.round(value)
}

// --- HTTP plumbing --------------------------------------------------------------

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function sendHtml(res: http.ServerResponse, html: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  })
  res.end(html)
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        reject(new HttpError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function readJson(req: http.IncomingMessage): Promise<RenderRequestBody> {
  return readBody(req).then((text) => {
    try {
      return JSON.parse(text)
    }
    catch {
      throw new HttpError(400, 'request body is not valid JSON')
    }
  })
}

/** length-safe constant-time compare (timingSafeEqual throws on mismatched lengths) */
function authorized(req: http.IncomingMessage): boolean {
  const provided = String(req.headers['x-md-token'] ?? '')
  const a = crypto.createHash('sha256').update(provided).digest()
  const b = crypto.createHash('sha256').update(token).digest()
  return crypto.timingSafeEqual(a, b)
}

function validateRenderBody(body: RenderRequestBody): void {
  if (typeof body.id !== 'string' || !/^[\w-]{1,128}$/.test(body.id))
    throw new HttpError(400, 'id must match [A-Za-z0-9_-]{1,128}')
  if (typeof body.markdown !== 'string')
    throw new HttpError(400, 'markdown must be a string')
}

// --- server ----------------------------------------------------------------------

let idleTimer: NodeJS.Timeout | undefined
let activeServer: http.Server | undefined

/** Orphan protection: exit when Sublime quit without calling /shutdown. */
function pokeIdle(): void {
  if (idleTimer !== undefined)
    clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    process.stderr.write(`[md-sublime] idle for ${idleSeconds}s, exiting\n`)
    activeServer?.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  }, idleSeconds * 1000)
}

export function startServer(): void {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      const status = err instanceof HttpError
        ? err.status
        : err instanceof ValidationError ? 400 : 500
      const message = err instanceof Error ? err.message : String(err)
      if (status === 500)
        process.stderr.write(`[md-sublime] ${req.method} ${req.url} failed: ${message}\n`)
      if (!res.headersSent)
        sendJson(res, status, { ok: false, error: message })
      else
        res.end()
    })
  })
  activeServer = server

  server.on('error', (err) => {
    process.stderr.write(`[md-sublime] server error: ${err.message}\n`)
    process.exit(78)
  })

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo
    // Startup protocol — the ONLY line ever written to stdout.
    process.stdout.write(`MDP1 ${port} ${token}\n`)
    pokeIdle()
  })

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 1000).unref()
    })
  }

  process.on('unhandledRejection', (err) => {
    process.stderr.write(`[md-sublime] unhandled rejection: ${String(err)}\n`)
  })
}

const VENDOR_MIME: Record<string, string> = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/** Serves the vendored mermaid (exact workspace version) for preview hydration. */
function serveVendor(res: http.ServerResponse, pathname: string): void {
  const relative = pathname.slice('/vendor/'.length)
  if (relative.includes('..') || relative.includes('\0')) {
    throw new HttpError(400, 'invalid vendor path')
  }
  const vendorPath = path.join(__dirname, 'vendor', relative)
  try {
    const asset = fs.readFileSync(vendorPath)
    const mime = VENDOR_MIME[path.extname(vendorPath)] ?? 'application/octet-stream'
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': asset.length,
      'Cache-Control': 'public, max-age=86400, immutable',
    })
    res.end(asset)
  }
  catch {
    throw new HttpError(404, `vendored asset not found: ${relative}`)
  }
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  pokeIdle()

  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const { pathname } = url
  const method = req.method ?? 'GET'

  if (method === 'GET' && pathname === '/health') {
    sendJson(res, 200, { ok: true, version: VERSION, docs: docs.size, pid: process.pid })
    return
  }

  if (method === 'POST' && pathname === '/shutdown') {
    if (!authorized(req))
      throw new HttpError(401, 'invalid token')
    res.on('finish', () => {
      process.stderr.write('[md-sublime] shutdown requested\n')
      process.exit(0)
    })
    sendJson(res, 200, { ok: true })
    return
  }

  if (method === 'POST' && pathname === '/render') {
    if (!authorized(req))
      throw new HttpError(401, 'invalid token')
    const body = await readJson(req)
    validateRenderBody(body)
    const result = await submitRender(body)
    sendJson(res, 200, { ok: true, ...result })
    return
  }

  if (method === 'GET' && pathname.startsWith('/vendor/')) {
    serveVendor(res, pathname)
    return
  }

  if (method === 'GET' && pathname.startsWith('/p/')) {
    const entry = docsBySlug.get(pathname.slice('/p/'.length))
    if (!entry)
      throw new HttpError(404, 'unknown preview document')
    sendHtml(res, entry.documentHtml)
    return
  }

  if (method === 'GET' && pathname.startsWith('/version/')) {
    const entry = docsBySlug.get(pathname.slice('/version/'.length))
    if (!entry)
      throw new HttpError(404, 'unknown preview document')
    sendJson(res, 200, { rev: entry.rev })
    return
  }

  throw new HttpError(404, `no route for ${method} ${pathname}`)
}

/** One-shot mode for `server.cjs --render-file <path>`: full document to stdout. */
export async function renderFileToStdout(filePath: string, options?: unknown, previewWidth?: number | string): Promise<void> {
  const markdown = fs.readFileSync(path.resolve(filePath), 'utf8')
  // CLI output may be viewed offline / piped anywhere — bake the server SVG
  const output = await buildPreviewOutput(markdown, options, { serverMermaid: true })
  const documentHtml = buildPreviewDocument(output.html, {
    slug: 'cli',
    rev: 1,
    pollMs: 0,
    title: path.basename(filePath),
    width: sanitizePreviewWidth(previewWidth),
  })
  process.stdout.write(documentHtml)
  if (output.warnings.length > 0) {
    for (const warning of output.warnings)
      process.stderr.write(`[md-sublime] warning: ${warning}\n`)
  }
}
