/**
 * Sidecar entry point.
 *
 * The polyfills below MUST run before anything imports @md/core (which expects
 * a browser-ish environment). The only static import is the side-effect-free
 * node:process builtin: under esbuild's CJS output the dynamic
 * `import('./server')` becomes a deferred `require()` of an already-bundled
 * module, so the plain statements below are guaranteed to execute before
 * @md/core loads — the same trick packages/mcp-server/run.mjs pulls off with
 * tsx.
 *
 * Ported from packages/mcp-server/run.mjs.
 */

import process from 'node:process'

function noop() {}
const g = globalThis as any

g.MathJax = {
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
