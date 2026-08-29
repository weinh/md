import { initRenderer } from '@md/core/renderer'
import { processCSS } from '@md/core/theme/cssProcessor'
import { generateCSSVariables, generateHeadingStyles } from '@md/core/theme/cssVariables'
import { postProcessHtml, renderMarkdown } from '@md/core/utils'
import { baseCSSContent, themeMap } from '@md/shared/configs/theme'
import juice from 'juice'
import { normalizeOptions } from './options'

/**
 * Standalone md→HTML pipeline for the Sublime preview sidecar.
 *
 * Restructured from `buildRenderedOutput` in packages/mcp-server/src/render-article.ts,
 * with two deliberate differences:
 * - theme CSS comes from `@md/shared/configs/theme` (bundled as strings by the
 *   `?raw` esbuild plugin) instead of fs reads relative to `import.meta.dirname`,
 *   which would break inside the bundle;
 * - code-block theme CSS failures degrade to a warning instead of throwing, so
 *   offline previews still render (just without syntax highlighting).
 */

const CODE_BLOCK_FETCH_TIMEOUT_MS = 10_000

/**
 * Shell design tokens the theme CSS expects from a host environment (the Web
 * App's index.css :root, or the VS Code extension's css/index.ts). Standalone
 * output has no such shell, so we define them here — otherwise `hsl(var(--foreground))`
 * and `var(--blockquote-background)` resolve to nothing and table borders /
 * blockquote backgrounds silently vanish. Mirrors
 * apps/web/src/services/export/share-styles.ts (adds --muted-foreground).
 */
const SHELL_VARS_CSS = `:root {
  --foreground: 0 0% 3.9%;
  --muted-foreground: 0 0% 45.1%;
  --blockquote-background: #f7f7f7;
}`

const hljsCssCache = new Map<string, string>()

function escapeStyleContent(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style')
}

async function fetchCodeBlockCSS(url: string, warnings: string[]): Promise<string> {
  const cached = hljsCssCache.get(url)
  if (cached !== undefined)
    return cached

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(CODE_BLOCK_FETCH_TIMEOUT_MS) })
    if (!response.ok)
      throw new Error(`HTTP ${response.status}`)

    const css = escapeStyleContent(await response.text())
    hljsCssCache.set(url, css)
    return css
  }
  catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError'
      ? `timed out after ${CODE_BLOCK_FETCH_TIMEOUT_MS}ms`
      : err instanceof Error ? err.message : String(err)
    warnings.push(`code block theme CSS unavailable (${reason}); code rendered without highlighting`)
    return ''
  }
}

/**
 * Inline every CSS rule into element `style=""` attributes and drop the
 * `<style>` tag, producing WeChat-ready HTML (WeChat strips `<style>` tags and
 * class-based rules). juice also resolves CSS variables — including nested
 * forms like `hsl(var(--foreground))` — to concrete values, which standalone
 * output needs since it has no host cascade. Mirrors the Web app's export
 * pipeline (apps/web/src/services/export/clipboard.ts).
 */
function inlineStylesheet(html: string): string {
  return juice(html, {
    inlinePseudoElements: true,
    preserveImportant: true,
  })
}

export interface PreviewOutput {
  /** `<style>` + `<section class="container">…</section>` fragment (or juice-inlined body when inlineStyles) */
  html: string
  frontMatter: unknown
  readingTime: { words: number, minutes: number }
  warnings: string[]
}

export async function buildPreviewOutput(markdown: string, rawOptions?: unknown): Promise<PreviewOutput> {
  const warnings: string[] = []
  const options = normalizeOptions(rawOptions)

  const renderer = initRenderer({
    isMacCodeBlock: options.isMacCodeBlock,
    isShowLineNumber: options.isShowLineNumber,
    citeStatus: options.citeStatus,
    countStatus: options.countStatus,
    themeMode: options.themeMode,
    legend: options.legend,
  })

  const { html: baseHtml, readingTime } = renderMarkdown(markdown, renderer)
  const processedHtml = postProcessHtml(baseHtml, readingTime, renderer)
  const { yamlData } = renderer.parseFrontMatterAndContent(markdown)

  const cssConfig = {
    primaryColor: options.primaryColor,
    fontFamily: options.fontFamily,
    fontSize: options.fontSize,
    isUseIndent: options.isUseIndent,
    isUseJustify: options.isUseJustify,
    headingStyles: options.headingStyles,
  }

  const hljsCSS = await fetchCodeBlockCSS(options.codeBlockTheme, warnings)

  let mergedCSS = [
    SHELL_VARS_CSS,
    generateCSSVariables(cssConfig),
    baseCSSContent,
    themeMap[options.theme] ?? themeMap.default,
    generateHeadingStyles(cssConfig),
    hljsCSS,
    escapeStyleContent(options.customCSS),
  ].filter(Boolean).join('\n\n')

  mergedCSS = processCSS(mergedCSS)

  const styledHtml = `<style>\n${mergedCSS}\n</style>\n${processedHtml}`
  const html = options.inlineStyles ? inlineStylesheet(styledHtml) : styledHtml

  return {
    html,
    frontMatter: yamlData,
    readingTime: {
      words: readingTime.words,
      minutes: readingTime.minutes,
    },
    warnings,
  }
}
