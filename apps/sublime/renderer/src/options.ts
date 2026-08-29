import type { HeadingLevel, HeadingStyles, HeadingStyleType } from '@md/shared/configs/style'
import type { ThemeName } from '@md/shared/configs/theme'
import {
  codeBlockThemeOptions,
  colorOptions,
  fontFamilyOptions,
  fontSizeOptions,
  headingStyleOptions,
  legendOptions,
} from '@md/shared/configs/style'
import { themeOptions } from '@md/shared/configs/theme'

/**
 * Option normalization for the preview sidecar.
 *
 * Unlike packages/mcp-server (which duplicates these lists in config-options.ts
 * because tsx cannot resolve Vite `?raw` imports), the esbuild bundle CAN import
 * `@md/shared/configs/style` directly — the `?raw` plugin in scripts/build.mjs
 * inlines the theme CSS — so this stays a single source of truth.
 */

export type LegendValue = (typeof legendOptions)[number] extends { value: infer T } ? T : never

const LEGEND_VALUES = new Set(legendOptions.map(option => option.value))
const THEME_NAMES = new Set<string>(themeOptions.map(option => option.value))
const FONT_SIZE_VALUES = new Set(fontSizeOptions.map(option => option.value))
const HEADING_STYLE_VALUES = new Set(headingStyleOptions.map(option => option.value))
const HEADING_LEVELS: readonly HeadingLevel[] = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']

const CODE_BLOCK_URL_PREFIX = 'https://cdn-doocs.oss-cn-shenzhen.aliyuncs.com/npm/highlightjs/11.11.1/styles/'

// Presets offered by the MCP server (packages/mcp-server/src/config-options.ts) that
// are absent from the shared list. The union keeps both option surfaces valid.
const MCP_ONLY_CODE_BLOCK_THEMES = [
  'monokai',
  'nord',
  'vs',
  'tokyo-night-light',
  'tokyo-night-dark',
] as const

/** The sidecar fetches these URLs, so the list must stay an allow-list. */
export const allowedCodeBlockThemeUrls = new Set<string>([
  ...codeBlockThemeOptions.map(option => option.value),
  ...MCP_ONLY_CODE_BLOCK_THEMES.map(name => `${CODE_BLOCK_URL_PREFIX}${name}.min.css`),
])

const DEFAULT_CODE_BLOCK_THEME = `${CODE_BLOCK_URL_PREFIX}github-dark.min.css`

/**
 * Mirrors `defaultRenderOptions` in packages/mcp-server/src/config-options.ts,
 * except `inlineStyles` defaults to false — browser preview gains nothing from
 * juice-inlining every rule (slow on large docs); the copy-WeChat-HTML command
 * overrides it back to true.
 */
export const defaultPreviewOptions = {
  theme: 'default' as ThemeName,
  primaryColor: colorOptions[0].value,
  fontFamily: fontFamilyOptions[0].value,
  fontSize: fontSizeOptions[2].value,
  legend: legendOptions[3].value as LegendValue,
  codeBlockTheme: DEFAULT_CODE_BLOCK_THEME,
  isMacCodeBlock: true,
  isShowLineNumber: false,
  citeStatus: false,
  countStatus: false,
  themeMode: 'light' as 'light' | 'dark',
  isUseIndent: false,
  isUseJustify: false,
  headingStyles: {} as HeadingStyles,
  customCSS: '',
  inlineStyles: false,
}

export type RenderOptionsInput = Partial<typeof defaultPreviewOptions>

export interface NormalizedRenderOptions {
  theme: ThemeName
  primaryColor: string
  fontFamily: string
  fontSize: string
  legend: string
  codeBlockTheme: string
  isMacCodeBlock: boolean
  isShowLineNumber: boolean
  citeStatus: boolean
  countStatus: boolean
  themeMode: 'light' | 'dark'
  isUseIndent: boolean
  isUseJustify: boolean
  headingStyles?: HeadingStyles
  customCSS: string
  inlineStyles: boolean
}

function asRecord(raw: unknown): Record<string, unknown> {
  return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {}
}

function pickString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key]
  return typeof value === 'string' ? value : undefined
}

function pickBoolean(raw: Record<string, unknown>, key: string): boolean | undefined {
  const value = raw[key]
  return typeof value === 'boolean' ? value : undefined
}

/** Thrown by normalizeOptions on invalid input; the server maps it to HTTP 400. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

/** Throws a ValidationError on invalid input; the server maps that to HTTP 400. */
export function normalizeOptions(raw: unknown): NormalizedRenderOptions {
  const input = asRecord(raw)

  const theme = pickString(input, 'theme') ?? defaultPreviewOptions.theme
  if (!THEME_NAMES.has(theme))
    throw new ValidationError(`theme must be one of ${[...THEME_NAMES].join(', ')}. Received: ${theme}`)

  const legend = pickString(input, 'legend') ?? defaultPreviewOptions.legend
  if (!LEGEND_VALUES.has(legend))
    throw new ValidationError(`legend must be one of ${[...LEGEND_VALUES].join(', ')}. Received: ${legend}`)

  const fontSize = pickString(input, 'fontSize') ?? defaultPreviewOptions.fontSize
  if (!FONT_SIZE_VALUES.has(fontSize))
    throw new ValidationError(`fontSize must be one of ${[...FONT_SIZE_VALUES].join(', ')}. Received: ${fontSize}`)

  const primaryColor = pickString(input, 'primaryColor') ?? defaultPreviewOptions.primaryColor
  if (!/^#[0-9a-f]{6}$/i.test(primaryColor))
    throw new ValidationError(`primaryColor must be a 6-digit hex color like #0F4C81. Received: ${primaryColor}`)

  const fontFamily = pickString(input, 'fontFamily') ?? defaultPreviewOptions.fontFamily

  const codeBlockTheme = pickString(input, 'codeBlockTheme') ?? defaultPreviewOptions.codeBlockTheme
  if (!allowedCodeBlockThemeUrls.has(codeBlockTheme)) {
    throw new ValidationError(
      `codeBlockTheme must be a preset URL (see allowedCodeBlockThemeUrls). Received: ${codeBlockTheme}`,
    )
  }

  const themeMode = pickString(input, 'themeMode') ?? defaultPreviewOptions.themeMode
  if (themeMode !== 'light' && themeMode !== 'dark')
    throw new ValidationError(`themeMode must be 'light' or 'dark'. Received: ${themeMode}`)

  const headingStyles = normalizeHeadingStyles(input.headingStyles)

  const customCSSRaw = pickString(input, 'customCSS') ?? defaultPreviewOptions.customCSS
  if (customCSSRaw.length > 100 * 1024)
    throw new ValidationError(`customCSS exceeds the 100 KiB limit (${customCSSRaw.length} bytes)`)

  return {
    theme: theme as ThemeName,
    primaryColor,
    fontFamily,
    fontSize,
    legend,
    codeBlockTheme,
    isMacCodeBlock: pickBoolean(input, 'isMacCodeBlock') ?? defaultPreviewOptions.isMacCodeBlock,
    isShowLineNumber: pickBoolean(input, 'isShowLineNumber') ?? defaultPreviewOptions.isShowLineNumber,
    citeStatus: pickBoolean(input, 'citeStatus') ?? defaultPreviewOptions.citeStatus,
    countStatus: pickBoolean(input, 'countStatus') ?? defaultPreviewOptions.countStatus,
    themeMode,
    isUseIndent: pickBoolean(input, 'isUseIndent') ?? defaultPreviewOptions.isUseIndent,
    isUseJustify: pickBoolean(input, 'isUseJustify') ?? defaultPreviewOptions.isUseJustify,
    headingStyles,
    customCSS: customCSSRaw.trim(),
    inlineStyles: pickBoolean(input, 'inlineStyles') ?? defaultPreviewOptions.inlineStyles,
  }
}

function normalizeHeadingStyles(raw: unknown): HeadingStyles | undefined {
  if (raw == null)
    return undefined
  const input = asRecord(raw)

  const normalized: HeadingStyles = {}
  for (const level of HEADING_LEVELS) {
    const style = input[level]
    if (style == null || style === 'default')
      continue
    if (typeof style !== 'string' || !HEADING_STYLE_VALUES.has(style))
      throw new ValidationError(`headingStyles.${level} must be one of ${[...HEADING_STYLE_VALUES].join(', ')}. Received: ${String(style)}`)
    normalized[level] = style as HeadingStyleType
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}
