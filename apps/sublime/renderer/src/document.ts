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
${cardCss(width)}`
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
</body>
</html>
`
}
