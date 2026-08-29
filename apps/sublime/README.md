# Md Preview — Sublime Text 4 插件

[English](#english) · 中文

在 **Sublime Text 4（build 4200+）** 中预览微信公众号格式的 Markdown，渲染核心来自
[doocs/md](https://github.com/doocs/md)（https://md.doocs.org），与网页编辑器同源的完整主题系统。

## 特性

- **浏览器预览**：完整还原微信样式（375px 文章栏宽、macOS 风格代码块、主题/主色/字体全套选项），Sublime 内置面板做不到
- **保存即刷新**：预览打开期间每次保存自动重渲染，浏览器标签 <1s 刷新且保持滚动位置
- **复制微信 HTML**：一键生成 juice 内联样式的成品 HTML，直接粘贴进公众号编辑器
- **本地运行**：渲染 sidecar 只监听 `127.0.0.1`（随机端口 + token 鉴权），空闲自动退出，不留后台进程

## 环境要求

- Sublime Text 4（build 4200 及以上）
- [Node.js](https://nodejs.org) **≥ 20**（运行打包好的渲染器；插件会自动在 PATH / Homebrew / nvm 中寻找，也可在设置中指定 `node_binary`）

## 安装

### 方式一：从本仓库构建（开发者）

```bash
git clone https://github.com/doocs/md
cd md
pnpm install
pnpm sublime package     # 产出 apps/sublime/release/MdPreview-v<version>.sublime-package
```

将 `.sublime-package` 文件放入 `Preferences → Browse Packages` 打开的目录的上一级 `Installed Packages/`，重启 Sublime。

本机开发调试：

```bash
pnpm sublime dev-install # 构建并同步到本机 Packages/ 目录
```

### 方式二：手动解包

把 `apps/sublime/plugin/` 目录（先 `pnpm sublime build`）复制为
`Packages/MdPreview/` 并重启 Sublime。zip 方式安装时插件会自动把渲染器解压到缓存目录，无需额外操作。

## 使用

| 命令                                  | 说明                                                                |
| ------------------------------------- | ------------------------------------------------------------------- |
| `Md Preview: Open Preview`            | 打开/刷新当前 Markdown 的浏览器预览（`super+alt+m` / `ctrl+alt+m`） |
| `Md Preview: Close Preview`           | 停止对该文件的保存自动刷新                                          |
| `Md Preview: Copy WeChat HTML`        | 微信成品 HTML（内联样式）复制到剪贴板                               |
| `Md Preview: Restart Renderer Server` | 重启渲染 sidecar（升级/排障用）                                     |

Markdown 识别：扩展名在 `markdown_file_extensions` 中，或语法为 `text.html.markdown`；未保存的缓冲区也可以预览。

预览页布局由 `preview_width` 控制：默认 `"adaptive"`（PC 宽屏阅读版式，最大 960px 居中）；设为固定像素值（如 `375`）则还原微信手机文章栏宽。改设置后保存任意被跟踪的 md 文件即可看到新版式。

## 设置

`Preferences → Package Settings → Md Preview → Settings`，全部选项带注释见
[plugin/MdPreview.sublime-settings](./plugin/MdPreview.sublime-settings)。渲染默认值与 doocs/md 网页端一致
（主题 `default`、主色 `#0F4C81`、字号 `16px`、macOS 代码块开启……），改完保存，下一次保存 md 文件即生效。

## 架构

```
Sublime (Python 3.8, 纯标准库)              Node 渲染 sidecar (esbuild 单文件)
┌──────────────────────────┐   spawn      ┌────────────────────────────────┐
│ md_preview_open 命令      │ ──────────▶  │ server.cjs（MDP1 启动协议：     │
│ 保存监听 on_post_save     │  stdout 一行  │   端口 + token）               │
│ MdServerProcess           │ ◀──────────  │ node:http @ 127.0.0.1          │
└──────────┬───────────────┘              │  POST /render  GET /p/:slug    │
           │ 浏览器打开                    │  GET /version/:slug（轮询刷新） │
           ▼                              └────────────────────────────────┘
   系统浏览器（页面轮询 /version，rev 变化即自动 reload）
```

- 渲染管线复用 `@md/core` + `@md/shared`（主题 CSS 经 esbuild `?raw` 插件以字符串打进 bundle，单一数据源）
- `isomorphic-dompurify`（jsdom 太大）沿用 VS Code 扩展方案，外置于 `renderer/runtime/node_modules` 随包分发
- 包内含 `.python-version`（声明 `3.8`）—— ST4 默认用 Python 3.3 宿主加载新包，而插件用了 `subprocess.run` 等 3.5+ API，必须显式声明
- 渲染器构建与协议细节见 [renderer/src/](./renderer/src/) 与 [scripts/](./scripts/)；排障时打开 `"debug": true`，日志在缓存目录（macOS：`~/Library/Caches/Sublime Text/Cache/MdPreview/`）

## 已知限制

- **Mermaid 已支持**：sidecar 在真实 jsdom 环境中做服务端两遍渲染，图表以内联 SVG 输出（与 md.doocs.org 一致），**Copy WeChat HTML 同样包含图表**。极端复杂的图表因 Node 侧无真实排版引擎，尺寸可能与浏览器略有出入
- **PlantUML 图表仍显示为占位符**（上游渲染依赖浏览器端 DOM，无法在 Node 复原）；数学公式正常（原生 MathML）
- **代码高亮主题 CSS 首次渲染需联网**（之后有缓存）；离线时代码块降级为无高亮，其余功能不受影响
- PlantUML 代码块每次渲染会请求 plantuml.com 官方服务器（上游行为）

---

## English

A Sublime Text 4 (build 4200+) Markdown preview package powered by the
[doocs/md](https://github.com/doocs/md) renderer — the same theme system as the
WeChat-format web editor.

**Features**: browser preview (full WeChat styling, 375px column), auto-refresh
on save with scroll preservation, one-click "Copy WeChat HTML" (juice-inlined,
paste-ready), and a fully local renderer sidecar (127.0.0.1, random port, token
auth, idle self-exit).

**Requirements**: Sublime Text 4 (build 4200+) and Node.js ≥ 20.

**Usage**: open a Markdown file and run `Md Preview: Open Preview`
(`super+alt+m` / `ctrl+alt+m`). Every save re-renders and the browser tab
refreshes itself. See the settings file for every option (theme, primary color,
fonts, code-block style, and more).

**Known limitations**: Mermaid diagrams ARE rendered (server-side, in a real
jsdom environment — inline SVG output matching md.doocs.org, included in
"Copy WeChat HTML" too; very complex diagrams may size slightly differently
than in a browser). PlantUML stays a placeholder; the code-highlight theme CSS
is fetched over the network on first render and degrades gracefully offline;
math renders via native MathML.
