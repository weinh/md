#!/usr/bin/env node

/**
 * Enhanced MCP server entry — same tools as `index.ts`, but `render_markdown`
 * can read its Markdown source directly from a file (and optionally write the
 * rendered HTML back to a file). This avoids the escaping/quoting headaches of
 * passing large or complex Markdown through a JSON string argument.
 *
 * Entry wrapper: run-file.mjs
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { buildRenderedOutput } from './render-article'
import {
  createServer,
  errorText,
  jsonText,
  registerListTools,
  renderOptionFields,
} from './server'

export const renderMarkdownFileInputSchema = {
  file: z
    .string()
    .optional()
    .describe(
      `Path to a Markdown file to render. Absolute, or relative to the server's working directory `
      + `(usually the project root). When provided, its contents are used as the Markdown source and `
      + `the inline \`markdown\` argument is ignored. Use this for long or complex documents to avoid `
      + `escaping quotes/backslashes in a JSON string.`,
    ),
  markdown: z
    .string()
    .optional()
    .describe(`Inline Markdown source text. Used only when \`file\` is not provided.`),
  outputFile: z
    .string()
    .optional()
    .describe(
      `Optional path to write the rendered HTML to. Absolute, or relative to the server's working directory. `
      + `When set, the HTML is written to disk and the response replaces the inline \`html\` with the output path.`,
    ),
  ...renderOptionFields,
}

const server = createServer()

server.registerTool(
  `render_markdown`,
  {
    description:
      `Render Markdown to styled HTML using the doocs/md rendering engine. `
      + `The Markdown source can be passed inline as a \`markdown\` string OR read from a local file via the `
      + `\`file\` path argument (preferred for long/complex documents — no escaping needed). `
      + `Optionally write the rendered HTML to \`outputFile\`. `
      + `Output is ready for WeChat Official Accounts (公众号) and other platforms. `
      + `Supports standard Markdown plus: KaTeX math, Mermaid diagrams, PlantUML, footnotes, alerts, `
      + `ruby annotations, sliders, and table-of-contents.`,
    inputSchema: renderMarkdownFileInputSchema,
  },
  async (args) => {
    const { file, markdown, outputFile, ...renderOptions } = args

    // Resolve the Markdown source: a `file` path wins over inline `markdown`.
    let source: string | undefined
    if (file) {
      const filePath = path.resolve(file)
      try {
        source = await fs.readFile(filePath, `utf8`)
      }
      catch (err) {
        return errorText(
          `[md-mcp-server] Failed to read Markdown file: ${filePath}\n${err instanceof Error ? err.message : err}`,
        )
      }
    }
    else {
      source = markdown
    }

    if (source == null || source.trim() === ``) {
      return errorText(
        `[md-mcp-server] No Markdown source provided. Pass either \`file\` (path to a .md file) or \`markdown\` (inline string).`,
      )
    }

    const result = await buildRenderedOutput({ markdown: source, ...renderOptions })

    if (outputFile) {
      const outPath = path.resolve(outputFile)
      try {
        await fs.writeFile(outPath, result.html, `utf8`)
      }
      catch (err) {
        return errorText(
          `[md-mcp-server] Failed to write HTML file: ${outPath}\n${err instanceof Error ? err.message : err}`,
        )
      }
      return jsonText({
        ...result,
        html: undefined,
        outputFile: outPath,
        message: `Rendered HTML written to ${outPath}.`,
      })
    }

    return jsonText(result)
  },
)

registerListTools(server)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write(`[md-mcp-server] running on stdio (file-enabled entry)\n`)
}

main().catch((err) => {
  process.stderr.write(`[md-mcp-server] fatal: ${err}\n`)
  process.exit(1)
})
