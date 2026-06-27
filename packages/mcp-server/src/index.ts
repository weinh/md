#!/usr/bin/env node

import process from 'node:process'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { buildRenderedOutput } from './render-article'
import { createServer, jsonText, registerListTools, renderOptionFields } from './server'

/**
 * Original `render_markdown` schema: the Markdown source MUST be supplied inline
 * as a `markdown` string. Behaviour here is unchanged from before the refactor —
 * the option fields are now shared via `renderOptionFields`, but the resulting
 * object is identical to what run.mjs has always exposed.
 */
export const renderMarkdownInputSchema = {
  markdown: z.string().describe(`The Markdown source text to render.`),
  ...renderOptionFields,
}

const server = createServer()

server.registerTool(
  `render_markdown`,
  {
    description:
      `Render Markdown text to styled HTML using the doocs/md rendering engine. `
      + `The output is ready to be used in WeChat Official Accounts (公众号) and other platforms. `
      + `Supports standard Markdown plus: KaTeX math, Mermaid diagrams, PlantUML, footnotes, alerts, `
      + `ruby annotations, sliders, and table-of-contents.`,
    inputSchema: renderMarkdownInputSchema,
  },
  async (args) => {
    const result = await buildRenderedOutput(args)
    return jsonText(result)
  },
)

registerListTools(server)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write(`[md-mcp-server] running on stdio\n`)
}

main().catch((err) => {
  process.stderr.write(`[md-mcp-server] fatal: ${err}\n`)
  process.exit(1)
})
