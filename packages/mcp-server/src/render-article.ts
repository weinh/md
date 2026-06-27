import type { ThemeName } from '@md/shared/configs'
import type { HeadingStyles } from '@md/shared/configs/style'
import type { HeadingStylesInput, LegendValue } from './config-options'
import fs from 'node:fs'
import path from 'node:path'
import { initRenderer } from '@md/core/renderer'
import { processCSS } from '@md/core/theme/cssProcessor'
import { generateCSSVariables, generateHeadingStyles } from '@md/core/theme/cssVariables'
import { postProcessHtml, renderMarkdown } from '@md/core/utils'
import {
  assertAllowedCodeBlockThemeUrl,
  defaultRenderOptions,
} from './config-options'

const CODE_BLOCK_FETCH_TIMEOUT_MS = 10_000

export interface RenderMarkdownInput {
  markdown: string
  theme?: ThemeName
  primaryColor?: string
  fontFamily?: string
  fontSize?: string
  legend?: LegendValue
  isMacCodeBlock?: boolean
  isShowLineNumber?: boolean
  citeStatus?: boolean
  countStatus?: boolean
  themeMode?: 'light' | 'dark'
  isUseIndent?: boolean
  isUseJustify?: boolean
  headingStyles?: HeadingStylesInput
  codeBlockTheme?: string
  customCSS?: string
}

const themeDir = path.resolve(import.meta.dirname, `../../shared/src/configs/theme-css`)

function escapeStyleContent(css: string): string {
  return css.replace(/<\/style/gi, `<\\/style`)
}

function loadCSSFile(filename: string): string {
  try {
    return fs.readFileSync(path.join(themeDir, filename), `utf-8`)
  }
  catch (err) {
    throw new Error(
      `[md-mcp-server] Failed to load CSS file: ${filename}. Ensure the monorepo source structure is intact.`,
      { cause: err },
    )
  }
}

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

const baseCSSContent = loadCSSFile(`base.css`)
const themeMap: Record<string, string> = {
  default: loadCSSFile(`default.css`),
  grace: loadCSSFile(`grace.css`),
  simple: loadCSSFile(`simple.css`),
}

const hljsCssCache = new Map<string, string>()

export async function fetchCodeBlockCSS(url: string): Promise<string> {
  assertAllowedCodeBlockThemeUrl(url)

  const cached = hljsCssCache.get(url)
  if (cached)
    return cached

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(CODE_BLOCK_FETCH_TIMEOUT_MS),
    })
    if (!response.ok)
      throw new Error(`Failed to fetch code block theme CSS (${response.status}): ${url}`)

    const css = escapeStyleContent(await response.text())
    hljsCssCache.set(url, css)
    return css
  }
  catch (err) {
    if (err instanceof Error && err.name === `TimeoutError`) {
      throw new Error(
        `Timed out fetching code block theme CSS after ${CODE_BLOCK_FETCH_TIMEOUT_MS}ms: ${url}`,
        { cause: err },
      )
    }
    throw err
  }
}

function normalizeHeadingStyles(input?: HeadingStylesInput): HeadingStyles | undefined {
  if (!input)
    return undefined

  const normalized: HeadingStyles = {}
  for (const [level, style] of Object.entries(input)) {
    if (style && style !== `default`)
      normalized[level as keyof HeadingStyles] = style
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

export async function buildRenderedOutput(input: RenderMarkdownInput) {
  const theme = input.theme ?? defaultRenderOptions.theme
  const primaryColor = input.primaryColor ?? defaultRenderOptions.primaryColor
  const fontFamily = input.fontFamily ?? defaultRenderOptions.fontFamily
  const fontSize = input.fontSize ?? defaultRenderOptions.fontSize
  const legend = input.legend ?? defaultRenderOptions.legend
  const codeBlockTheme = input.codeBlockTheme ?? defaultRenderOptions.codeBlockTheme
  const headingStyles = normalizeHeadingStyles(input.headingStyles)

  const renderer = initRenderer({
    isMacCodeBlock: input.isMacCodeBlock ?? defaultRenderOptions.isMacCodeBlock,
    isShowLineNumber: input.isShowLineNumber ?? defaultRenderOptions.isShowLineNumber,
    citeStatus: input.citeStatus ?? defaultRenderOptions.citeStatus,
    countStatus: input.countStatus ?? defaultRenderOptions.countStatus,
    themeMode: input.themeMode ?? defaultRenderOptions.themeMode,
    legend,
  })

  const { html: baseHtml, readingTime } = renderMarkdown(input.markdown, renderer)
  const processedHtml = postProcessHtml(baseHtml, readingTime, renderer)
  const { yamlData } = renderer.parseFrontMatterAndContent(input.markdown)

  const cssConfig = {
    primaryColor,
    fontFamily,
    fontSize,
    isUseIndent: input.isUseIndent ?? defaultRenderOptions.isUseIndent,
    isUseJustify: input.isUseJustify ?? defaultRenderOptions.isUseJustify,
    headingStyles,
  }

  const variablesCSS = generateCSSVariables(cssConfig)
  const headingStylesCSS = generateHeadingStyles(cssConfig)
  const themeCSS = themeMap[theme] || themeMap.default
  const hljsCSS = codeBlockTheme ? await fetchCodeBlockCSS(codeBlockTheme) : ``
  const customCSS = escapeStyleContent(input.customCSS?.trim() ?? ``)

  let mergedCSS = [
    SHELL_VARS_CSS,
    variablesCSS,
    baseCSSContent,
    themeCSS,
    headingStylesCSS,
    hljsCSS,
    customCSS,
  ].filter(Boolean).join(`\n\n`)

  mergedCSS = processCSS(mergedCSS)

  const html = `<style>\n${mergedCSS}\n</style>\n${processedHtml}`

  return {
    html,
    frontMatter: yamlData,
    readingTime: {
      words: readingTime.words,
      minutes: readingTime.minutes,
    },
  }
}

export function clearHljsCssCache() {
  hljsCssCache.clear()
}
