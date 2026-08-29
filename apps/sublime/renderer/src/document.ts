/**
 * Full HTML document wrapper for the browser preview.
 *
 * Evolves the WeChat-width container from apps/vscode/src/previewRenderer.ts
 * `wrapHtmlTag` into a real document: meta charset/viewport, a gray stage with a
 * white article card, scroll restoration across reloads, and a tiny poller that
 * reloads the page when the server reports a newer revision (save → re-render →
 * refresh, no browser extension needed).
 */

/**
 * Layout width of the article card:
 * - 'adaptive' (default): PC-width reading layout — fills the window up to
 *   960px, centered
 * - number: fixed column width in px (e.g. 375 reproduces the WeChat phone
 *   article column)
 */
export type PreviewWidth = 'adaptive' | number

export interface PreviewDocumentOptions {
  /** server-minted document id, `[a-z0-9-]` only — interpolated into HTML/JS */
  slug: string
  /** current revision; the page reloads when the server reports a higher one */
  rev: number
  /** poll interval in ms; `0` disables the poller (one-shot renders) */
  pollMs: number
  title: string
  width?: PreviewWidth
  /** mermaid theme for client-side hydration ('default' | 'dark') */
  mermaidTheme?: 'default' | 'dark'
}

function cardCss(width: PreviewWidth | undefined): string {
  const sizing = width === undefined || width === 'adaptive'
    ? `width: 100%;
  max-width: 960px;`
    : `width: ${width}px;`
  return `.md-preview-card {
  ${sizing}
  margin: 0 auto;
  background: #fff;
  box-sizing: border-box;
  padding: ${width === undefined || width === 'adaptive' ? '24px 32px' : '20px'};
  font-size: ${width === undefined || width === 'adaptive' ? '15px' : '14px'};
  word-wrap: break-word;
}`
}

function shellCss(width: PreviewWidth | undefined): string {
  return `body {
  margin: 0;
  background: #ececec;
  padding: 24px 0;
}
${cardCss(width)}
/* the article CSS contains an unscoped \`p { margin; letter-spacing }\` rule
   that leaks into mermaid's temp measurement context (appended to <body>, not
   the card) and widens every diagram. md.doocs.org scopes its article CSS, so
   replicate that isolation — these reset rules must stay GLOBAL to also cover
   the detached measurement elements */
.md-preview-card .mermaid-diagram p,
.nodeLabel p,
.edgeLabel p,
.cluster-label p {
  margin: 0;
  letter-spacing: normal;
}`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildPollerScript(options: PreviewDocumentOptions): string {
  if (options.pollMs <= 0)
    return ''

  return `<script>
(function () {
  var REV = ${options.rev}, POLL = ${options.pollMs}, SLUG = "${options.slug}";
  var key = "md-scroll-" + SLUG, y = null;
  try { y = sessionStorage.getItem(key) } catch (e) {}
  addEventListener("scroll", function () {
    try { sessionStorage.setItem(key, String(scrollY)) } catch (e) {}
  });
  if (y) scrollTo(0, +y);
  setInterval(function () {
    fetch("/version/" + SLUG).then(function (r) { return r.json() }).then(function (d) {
      if (d.rev > REV) location.reload();
    }).catch(function () {});
  }, POLL);
})();
</script>`
}

/**
 * Client-side mermaid hydration — the md.doocs.org mechanism. The renderer's
 * placeholder carries the diagram source (base64 in data-mermaid-src); the
 * browser renders it with real mermaid, real fonts, real layout. The script is
 * served by the sidecar at /vendor/mermaid.mjs (the exact workspace version,
 * so rendering matches the web app); the CDN is only a fallback.
 * Matches @md/core's getMermaidThemeConfig and the extension's error styling.
 */
const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'

function buildMermaidScript(fragment: string, theme: 'default' | 'dark' | undefined): string {
  if (!fragment.includes('data-mermaid-src'))
    return ''

  return `<script type="module">
(async function () {
  var mermaid;
  try { mermaid = (await import("/vendor/mermaid.mjs")).default; }
  catch (e) { mermaid = (await import("${MERMAID_CDN}")).default; }
  mermaid.initialize({ startOnLoad: false, theme: "${theme ?? 'default'}", themeVariables: { darkMode: ${theme === 'dark'} } });
  var nodes = document.querySelectorAll(".mermaid-diagram[data-mermaid-src]");
  nodes.forEach(function (el, i) {
    if (el.getAttribute("data-md-diagram-state") !== "loading")
      return;
    var bin = atob(el.getAttribute("data-mermaid-src"));
    var bytes = new Uint8Array(bin.length);
    for (var j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
    var src = new TextDecoder("utf-8").decode(bytes);
    mermaid.render(el.id + "-live-" + i, src).then(function (r) {
      el.innerHTML = r.svg;
      el.setAttribute("data-md-diagram-state", "ready");
    }).catch(function (e) {
      el.setAttribute("data-md-diagram-state", "error");
      el.innerHTML = '<div style="color: red; padding: 10px; border: 1px solid red;">Mermaid 渲染失败: ' +
        String((e && e.message) || e).replace(/</g, "&lt;") + "</div>";
    });
  });
})();
</script>`
}

export function buildPreviewDocument(fragment: string, options: PreviewDocumentOptions): string {
  // slug is minted from [a-z0-9-] and rev/pollMs are numbers — no escaping needed there
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>${shellCss(options.width)}</style>
</head>
<body>
<main class="md-preview-card">
${fragment}
</main>
${buildPollerScript(options)}
${buildMermaidScript(fragment, options.mermaidTheme)}
</body>
</html>
`
}
