import type { DiagramMessages } from '@md/shared/types'
import type { MarkedExtension, Token } from 'marked'
import type { MermaidToken } from '../types/marked-tokens'
import type { DiagramThemeMode } from './diagram-theme'
import { asDiagramToken, asTextTokenRenderer, isCodeToken } from '../types/marked-tokens'
import {
  diagramStateAttr,
  formatDiagramMessage,
  MD_DIAGRAM_STATE,
  MD_DIAGRAM_STATE_ATTR,
  resolveDiagramMessages,
} from '../utils/asyncDiagramState'
import { simpleHash } from '../utils/basicHelpers'
import { createSVGCache } from '../utils/svgCache'
import { diagramCacheThemeSuffix, getMermaidThemeConfig } from './diagram-theme'

let initPromise: Promise<typeof import('mermaid')['default']> | null = null

interface MermaidOptions {
  themeMode?: DiagramThemeMode
  diagramMessages?: DiagramMessages
}

type MermaidOptionsSource = MermaidOptions | (() => MermaidOptions | undefined)

let optionsSource: MermaidOptionsSource | undefined

function resolveOptions(): MermaidOptions | undefined {
  return typeof optionsSource === `function` ? optionsSource() : optionsSource
}

function getDiagramMessages(): DiagramMessages {
  return resolveDiagramMessages(resolveOptions()?.diagramMessages)
}

export async function initializeMermaid() {
  return getMermaid()
}

function getMermaid() {
  if (!initPromise) {
    initPromise = import('mermaid').then((m) => {
      m.default.initialize(getMermaidThemeConfig())
      return m.default
    })
  }
  return initPromise
}

function buildCacheKey(code: string, themeMode?: DiagramThemeMode): string {
  return simpleHash(`${code}-${diagramCacheThemeSuffix(themeMode)}`)
}

/**
 * 将图源以 base64（UTF-8 安全）嵌入占位符的 data 属性，供浏览器端用真实
 * mermaid 渲染——与 Web 应用（md.doocs.org）在浏览器中渲染图表同一机制，
 * 字体度量与布局与演示站完全一致。base64 字符集对 HTML 属性安全，
 * DOMPurify 默认放行 data-* 属性。
 */
function encodeDiagramSource(code: string): string {
  const bytes = new TextEncoder().encode(code)
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary)
}

// key -> svg（LRU 缓存，上限 50 条）
const svgCache = createSVGCache(50)

// 在途的异步渲染；renderMermaid 是 fire-and-forget 的，这里补一个可等待的句柄
const pendingRenders = new Set<Promise<void>>()

async function renderMermaidSvg(code: string, themeMode?: DiagramThemeMode): Promise<string> {
  const cacheKey = buildCacheKey(code, themeMode)
  const cached = svgCache.get(cacheKey)
  if (cached)
    return cached

  const mermaid = await getMermaid()
  mermaid.initialize(getMermaidThemeConfig(themeMode))
  const result = await mermaid.render(`mermaid-svg-${cacheKey}`, code)
  svgCache.set(cacheKey, result.svg)
  return result.svg
}

function renderMermaid(id: string, code: string, cacheKey: string, themeMode?: DiagramThemeMode) {
  if (typeof window === `undefined`)
    return

  const handleResult = (svg: string) => {
    svgCache.set(cacheKey, svg)

    const el = document.getElementById(id)
    if (el) {
      el.innerHTML = svg
      el.setAttribute(MD_DIAGRAM_STATE_ATTR, MD_DIAGRAM_STATE.ready)
    }
  }

  const handleError = (error: unknown) => {
    console.error('Failed to render Mermaid:', error)
    const el = document.getElementById(id)
    if (el) {
      const detail = error instanceof Error ? error.message : String(error)
      const messages = getDiagramMessages()
      el.innerHTML = `<div style="color: red; padding: 10px; border: 1px solid red;">${formatDiagramMessage(messages.mermaidError, detail)}</div>`
      el.setAttribute(MD_DIAGRAM_STATE_ATTR, MD_DIAGRAM_STATE.error)
    }
  }

  const tracked = renderMermaidSvg(code, themeMode)
    .then(handleResult)
    .catch(handleError)
    .finally(() => {
      pendingRenders.delete(tracked)
    })
  pendingRenders.add(tracked)
}

/**
 * 等待所有在途的 Mermaid 异步渲染结束（成功或失败）。
 *
 * 同步渲染（marked）只会触发渲染并返回占位符；Node 侧消费者（sidecar、
 * SSR）可在首遍渲染后 await 本函数，再重新渲染同一内容——此时 svgCache
 * 已填充，同步路径会直接内联 SVG。
 */
export async function waitForMermaid(): Promise<void> {
  while (pendingRenders.size > 0)
    await Promise.allSettled([...pendingRenders])
}

export function markedMermaid(options?: MermaidOptionsSource): MarkedExtension {
  optionsSource = options
  const className = 'mermaid-diagram'

  return {
    extensions: [
      {
        name: 'mermaid',
        level: 'block',
        start(src: string) {
          return src.match(/^```mermaid/m)?.index
        },
        tokenizer(src: string) {
          const match = /^```mermaid\r?\n([\s\S]*?)\r?\n```/.exec(src)
          if (match) {
            return {
              type: 'mermaid',
              raw: match[0],
              text: match[1].trim(),
            }
          }
        },
        renderer: asTextTokenRenderer((token: MermaidToken) => {
          const code = token.text
          const currentOptions = resolveOptions()
          const themeMode = currentOptions?.themeMode
          const cacheKey = buildCacheKey(code, themeMode)

          const cached = svgCache.get(cacheKey)
          if (cached) {
            return `<!--mermaid-start--><div class="${className}">${cached}</div><!--mermaid-end-->`
          }

          const id = `mermaid-${cacheKey}`
          renderMermaid(id, code, cacheKey, themeMode)

          const messages = getDiagramMessages()
          return `<!--mermaid-start--><div id="${id}" class="${className}" ${diagramStateAttr(MD_DIAGRAM_STATE.loading)} data-mermaid-src="${encodeDiagramSource(code)}">${messages.mermaidLoading}</div><!--mermaid-end-->`
        }),
      },
    ],
    walkTokens(token: Token) {
      if (isCodeToken(token) && token.lang === 'mermaid') {
        asDiagramToken<MermaidToken>(token, 'mermaid')
      }
    },
  }
}
