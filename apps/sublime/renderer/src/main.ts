/**
 * Sidecar entry point.
 *
 * The environment setup below MUST run before anything imports @md/core
 * (which expects a browser-ish DOM). The only static imports are
 * side-effect-free node builtins: under esbuild's CJS output the dynamic
 * `import('./server')` becomes a deferred `require()` of an already-bundled
 * module, so the statements below are guaranteed to execute before @md/core
 * loads — the same trick packages/mcp-server/run.mjs pulls off with tsx.
 *
 * When jsdom is available (it always is: isomorphic-dompurify ships it in
 * renderer/runtime/node_modules) we install a REAL window/document instead of
 * the stub — that is what lets Mermaid's renderer actually run in Node, so
 * diagrams come out as inline SVG after the cache warm-up pass (see
 * render.ts). The stub remains as a degraded fallback.
 */

import { createRequire } from 'node:module'
import process from 'node:process'

function noop() {}
const g = globalThis as any

function buildMathJaxStub() {
  return {
    texReset() {},
    tex2svg(latex: string) {
      const svgStyle: Record<string, any> = {}
      const styleProxy = new Proxy(svgStyle, {
        set(_, prop: string, value: any) { svgStyle[prop] = value; return true },
        get(_, prop: string) {
          if (prop === 'setProperty')
            return (p: string, v: any) => { svgStyle[p] = v }
          if (prop === 'display')
            return svgStyle[prop] || ''
          return svgStyle[prop]
        },
      })
      return {
        firstChild: {
          outerHTML: `<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>${latex.replace(/</g, '&lt;')}</mi></math>`,
          style: styleProxy,
          getAttribute: () => null,
          removeAttribute: noop,
        },
      }
    },
  }
}

function installStubGlobals() {
  g.MathJax = buildMathJaxStub()
  g.window = {
    MathJax: g.MathJax,
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 16),
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  }
  g.document = {
    getElementById: () => null,
    documentElement: { getAttribute: () => null, style: {} },
    createDocumentFragment: () => ({ appendChild: noop, childNodes: [] }),
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: (tag: string) => ({
      tagName: tag.toUpperCase(),
      setAttribute: noop,
      appendChild: noop,
      innerHTML: '',
      style: {},
    }),
    createTextNode: (text: string) => ({ textContent: text, data: text }),
    body: { appendChild: noop },
    head: { appendChild: noop },
  }
}

/** jsdom has SVG elements but no SVG layout — approximate box metrics from text. */
function patchSvgMetrics(window: any) {
  const estimate = (text: string) => {
    const lineWidth = (line: string) => {
      let width = 0
      for (const ch of line.trim()) {
        // CJK/fullwidth glyphs are font-size wide, latin ~half of it
        width += ch.codePointAt(0)! >= 0x2E80 ? 16 : 8.4
      }
      return width
    }
    const lines = text.split('\n')
    let width = 0
    for (const line of lines)
      width = Math.max(width, lineWidth(line))
    return { width: Math.max(width, 16), height: Math.max(lines.length * 16, 16) }
  }

  // non-visual SVG elements carry their payload (CSS!) in textContent — and the
  // payload leaks into ancestors' textContent too (measuring the <svg> root once
  // produced a 44000px-wide flowchart), so text estimation skips them entirely
  const NON_VISUAL = new Set(['STYLE', 'SCRIPT', 'TITLE', 'DESC', 'META', 'LINK'])

  function visualText(node: any): string {
    if (node.nodeType !== 1)
      return node.nodeType === 3 ? node.data : ''
    if (NON_VISUAL.has(node.tagName))
      return ''
    let text = ''
    for (const child of node.childNodes)
      text += visualText(child)
    return text
  }

  /**
   * Container getBBox (mermaid's setupGraphViewbox measures the ROOT <svg>):
   * jsdom has no renderer, but dagre-based layouts put every coordinate into
   * attributes — translate() transforms, rect/path geometry, text anchors —
   * so the union of the subtree's attribute geometry IS the bbox.
   */
  function parseTranslate(el: any): [number, number] {
    const transform = el.getAttribute?.('transform')
    if (!transform)
      return [0, 0]
    const m = /translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/.exec(transform)
      ?? /translate\(\s*(-?[\d.]+)/.exec(transform)
    return m ? [Number(m[1]), Number(m[2] ?? 0)] : [0, 0]
  }

  function leafGeometry(el: any): { x: number, y: number, w: number, h: number } | null {
    const num = (name: string): number | null => {
      const value = Number(el.getAttribute?.(name))
      return Number.isFinite(value) ? value : null
    }
    const tag = el.tagName

    if (tag === 'RECT') {
      const w = num('width'); const h = num('height')
      if (w === null || h === null)
        return null
      return { x: num('x') ?? 0, y: num('y') ?? 0, w, h }
    }
    if (tag === 'CIRCLE') {
      const r = num('r')
      if (r === null)
        return null
      return { x: (num('cx') ?? 0) - r, y: (num('cy') ?? 0) - r, w: 2 * r, h: 2 * r }
    }
    if (tag === 'ELLIPSE') {
      const rx = num('rx'); const ry = num('ry')
      if (rx === null || ry === null)
        return null
      return { x: (num('cx') ?? 0) - rx, y: (num('cy') ?? 0) - ry, w: 2 * rx, h: 2 * ry }
    }
    if (tag === 'IMAGE' || tag === 'FOREIGNOBJECT') {
      return { x: num('x') ?? 0, y: num('y') ?? 0, w: num('width') ?? 0, h: num('height') ?? 0 }
    }
    if (tag === 'PATH') {
      const d = el.getAttribute?.('d')
      if (!d)
        return null
      const nums = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []
      if (nums.length < 2)
        return null
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
      for (let i = 0; i + 1 < nums.length; i += 2) {
        minX = Math.min(minX, nums[i]); maxX = Math.max(maxX, nums[i])
        minY = Math.min(minY, nums[i + 1]); maxY = Math.max(maxY, nums[i + 1])
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
    }
    if (tag === 'LINE') {
      const x1 = num('x1') ?? 0; const y1 = num('y1') ?? 0; const x2 = num('x2') ?? 0; const y2 = num('y2') ?? 0
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
    }

    // text/tspan and anything else: estimated from visual text; y is the baseline
    const text = estimate(visualText(el))
    return { x: num('x') ?? 0, y: (num('y') ?? text.height) - text.height, w: text.width, h: text.height }
  }

  function unionGeometry(el: any, tx: number, ty: number, box: { minX: number, minY: number, maxX: number, maxY: number }) {
    if (NON_VISUAL.has(el.tagName) || el.tagName === 'DEFS')
      return
    const [ox, oy] = parseTranslate(el)
    const x = tx + ox
    const y = ty + oy

    if (el.children && el.children.length > 0) {
      for (const child of el.children)
        unionGeometry(child, x, y, box)
      return
    }

    const geometry = leafGeometry(el)
    if (geometry) {
      box.minX = Math.min(box.minX, x + geometry.x)
      box.minY = Math.min(box.minY, y + geometry.y)
      box.maxX = Math.max(box.maxX, x + geometry.x + geometry.w)
      box.maxY = Math.max(box.maxY, y + geometry.y + geometry.h)
    }
  }

  function containerBBox(el: any) {
    const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    unionGeometry(el, 0, 0, box)
    if (box.minX === Infinity || box.maxX < box.minX || box.maxY < box.minY)
      return { x: 0, y: 0, width: 0, height: 0 }
    return { x: box.minX, y: box.minY, width: box.maxX - box.minX, height: box.maxY - box.minY }
  }

  // NOTE: patch SVGElement.prototype, not SVGGraphicsElement — in jsdom <text>
  // elements inherit SVGElement directly and skip SVGGraphicsElement entirely.
  // mermaid measures freshly-created <text> (with tspan children), so this
  // always estimates from text content.
  const svgProto = window.SVGElement?.prototype
  if (svgProto && typeof svgProto.getBBox !== 'function') {
    svgProto.getBBox = function () {
      if (NON_VISUAL.has(this.tagName))
        return { x: 0, y: 0, width: 0, height: 0 }
      if (this.children && this.children.length > 0)
        return containerBBox(this)
      const { width, height } = estimate(visualText(this))
      return { x: 0, y: 0, width, height }
    }
  }

  // jsdom's getBoundingClientRect is all zeros; mermaid/d3 read it for sizing
  // (htmlLabels measure their divs, which may wrap spans)
  const elementProto = window.Element?.prototype
  if (elementProto && !elementProto.__mdPreviewMetricsPatched) {
    elementProto.__mdPreviewMetricsPatched = true
    elementProto.getBoundingClientRect = function () {
      if (NON_VISUAL.has(this.tagName))
        return { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }
      const { width, height } = estimate(visualText(this))
      return { x: 0, y: 0, width, height, left: 0, top: 0, right: width, bottom: height }
    }
  }
}

/** mermaid v11 uses constructible stylesheets; jsdom's CSSStyleSheet can't `new`. */
function installConstructibleStylesheets(window: any) {
  const proto = window.CSSStyleSheet?.prototype
  if (proto && typeof proto.replaceSync === 'function')
    return

  class FakeCSSStyleSheet {
    private cssText = ''
    replaceSync(css: string) { this.cssText = css }
    replace(css: string) { this.cssText = css; return Promise.resolve(this) }
    get cssRules() { return [] }
  }
  window.CSSStyleSheet = FakeCSSStyleSheet
}

/**
 * Copy jsdom window globals (CSSStyleSheet, Event, DOMParser, …) onto
 * globalThis for bare-identifier lookups in bundled browser code. Existing
 * Node globals (setTimeout, console, …) are never overridden.
 */
function exposeWindowGlobals(window: any) {
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key === 'window' || key === 'document' || key === 'globalThis')
      continue
    try {
      if (g[key] === undefined)
        g[key] = window[key]
    }
    catch {
      // some jsdom accessors throw on read — skip them
    }
  }
}

function installJsdomGlobals(): boolean {
  let JSDOM: any
  try {
    // resolved at runtime from renderer/runtime/node_modules (installed by
    // copy-runtime-deps.mjs alongside isomorphic-dompurify's jsdom)
    JSDOM = createRequire(__filename)('./runtime/node_modules/jsdom').JSDOM
  }
  catch {
    return false
  }

  try {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      pretendToBeVisual: true,
      url: 'https://md-preview.local/',
    })
    const window = dom.window as any
    if (!window.matchMedia)
      window.matchMedia = () => ({ matches: false, media: '', addEventListener: noop, removeEventListener: noop })
    window.MathJax = buildMathJaxStub()
    patchSvgMetrics(window)
    installConstructibleStylesheets(window)

    g.window = window
    g.document = window.document
    g.MathJax = window.MathJax
    exposeWindowGlobals(window)
    return true

    g.window = window
    g.document = window.document
    g.MathJax = window.MathJax
    return true
  }
  catch (err) {
    process.stderr.write(`[md-sublime] jsdom setup failed, falling back to stub globals: ${String(err)}\n`)
    return false
  }
}

if (!installJsdomGlobals())
  installStubGlobals()

async function bootstrap(): Promise<void> {
  const [{ startServer, renderFileToStdout }, fs] = await Promise.all([
    import('./server'),
    import('node:fs'),
  ])

  const args = process.argv.slice(2)
  const fileFlagIndex = args.indexOf('--render-file')
  if (fileFlagIndex !== -1) {
    const file = args[fileFlagIndex + 1]
    if (!file) {
      process.stderr.write('[md-sublime] --render-file requires a path argument\n')
      process.exit(2)
    }
    const optionsFlagIndex = args.indexOf('--options-file')
    const optionsPath = optionsFlagIndex !== -1 ? args[optionsFlagIndex + 1] : undefined
    const parsed = optionsPath
      ? JSON.parse(fs.readFileSync(optionsPath, 'utf8'))
      : {}
    const { previewWidth, ...renderOptions } = parsed ?? {}
    await renderFileToStdout(file, Object.keys(renderOptions).length > 0 ? renderOptions : undefined, previewWidth)
    return
  }

  startServer()
}

bootstrap().catch((err) => {
  process.stderr.write(`[md-sublime] fatal: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
