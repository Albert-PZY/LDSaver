# LDSaver

[English](#english) | [中文](#中文)

---

<a id="english"></a>

# LDSaver (English)

A Tampermonkey / Greasemonkey userscript that exports [linux.do](https://linux.do) forum posts to **Markdown** or **PDF**, with optional original-image packaging as a ZIP archive. Built-in code syntax highlighting, gentle rate limiting, and a polished floating control panel.

> Version: 1.5.3 · Author: albert · Namespace: `https://linux.do/`

## Features

- **Export to Markdown** — converts forum HTML to clean Markdown (headings, lists, blockquotes, tables, code blocks, links, images, mentions, hashtags, quotes, oneboxes).
- **Export to PDF** — renders Markdown → styled HTML → A4 PDF via `html2pdf.js`, images are inlined as data URLs so the PDF is self-contained.
- **Optional original images** — downloads original images referenced in the post and packs them together with the `.md` file into a ZIP. The Markdown links point to the local image paths. Images are stored directly (no double compression) when they are already in a compressed format (`png`/`jpg`/`webp`/`gif`/`avif`).
- **Code syntax highlighting** — language auto-detection (bash, python, javascript, typescript, go, rust, java, c/cpp, sql, json, html, css, ...) with a GitHub-dark style highlighter for both Markdown code blocks and PDF output.
- **Floor range selection** — export only the first post, the first 5/10/50 floors, all floors, or any custom range.
- **YAML frontmatter & metadata** — optional frontmatter block and post-meta header (title, URL, author, created date, tags).
- **Gentle rate limiting** — API and image requests are throttled with jitter, batch-gap, and concurrency caps. 429 responses are retried with exponential backoff up to a configurable limit.
- **Floating draggable panel** — Apple-style translucent control panel that docks to either edge; remembers the side and vertical position during the session. Auto light/dark mode.
- **No build step** — single `.user.js` file; dependencies (`html2pdf.js`, `jszip`) are loaded lazily from the jsDelivr CDN.

## Installation

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey / Greasemonkey).
2. Open `LDSaver.user.js` and click **Raw** (or drag the file into your browser's userscript manager), then approve the install.
3. Visit any post on `https://linux.do/...` — a small handle appears on the right (or left) edge of the screen. Click it to open the export panel.

### Optional `@require` modules

The script `@require`s two libraries from jsDelivr; if your userscript manager honors the metadata block, they are injected automatically:

- `html2pdf.js@0.10.2` — used for PDF rendering.
- `jszip@3.10.1` — used for ZIP packaging with images.

If `@require` injection is blocked, the script falls back to loading them lazily at runtime via a `<script>` tag.

## Usage

1. Navigate to a linux.do topic, e.g. `https://linux.do/t/topic/123`.
2. Click the handle on the screen edge to open the **导出工具 / Export** panel.
3. Choose a floor range via the chips (`仅主楼` / `前5楼` / `前10楼` / `前50楼` / `全部`) or type custom from/to values.
4. Toggle the options as needed:
   - **YAML frontmatter** — prepend a YAML metadata block to the Markdown.
   - **帖子元信息 / Post metadata** — prepend a blockquote with the source URL, author, date, tags.
   - **每楼楼层头 / Per-floor header** — prefix each floor with `### 第 N 楼 · author (@username) · date`.
   - **下载图片到本地 / Download original images** — fetch original images and pack them with the `.md` into a ZIP. If unchecked, the Markdown uses online image links.
5. Click **导出 Markdown** to get the `.md` file (or `.zip` if images are enabled), or **导出 PDF** to get a self-contained A4 PDF.

> The control panel can be dragged by its header; release it near the left or right edge to dock it on that side.

## Rate-limiting configuration

The `RATE` constants at the top of the script control the politeness of network access:

| Key              | Default | Meaning                                                |
| ---------------- | ------- | ------------------------------------------------------ |
| `apiGap`         | 1000 ms | Minimum interval between API calls (base)             |
| `apiJitter`      | 400 ms  | Random jitter added to `apiGap`                       |
| `batchSize`      | 8       | Posts requested per `/t/<id>/posts.json` batch        |
| `batchGap`       | 1500 ms | Gap between post batches (with jitter)                |
| `imgGap`         | 280 ms  | Minimum interval between image fetches (base)         |
| `imgJitter`      | 120 ms  | Random jitter added to `imgGap`                       |
| `imgConcurrency` | 3       | Concurrent image download workers                     |
| `retries`        | 4       | Max retries on API errors                             |
| `maxImages`      | 120     | Max images collected per topic                        |
| `warnFloors`     | 80      | Floor-range threshold for the "slow fetch" warning    |

Tune these if you hit rate limits (HTTP 429) frequently.

## API references used

The script reads the standard Discourse topic endpoints on `linux.do`:

- `/t/<topic_id>.json` — topic metadata and the first chunk of posts.
- `/t/<topic_id>/posts.json?post_ids[]=...` — batched fetch of additional posts by id.

Both are called with `credentials: include` so your existing forum login is used; no separate auth setup is needed.

## Supported HTML constructs

The HTML-to-Markdown converter handles:

- Headings (`h1`–`h6`), paragraphs, `<hr>`, `<br>`
- Inline `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``
- Fenced code blocks with language auto-detection
- Ordered / unordered lists with nesting
- Blockquotes, including Discourse `<aside class="quote">` quote blocks (with author + post number)
- Tables (GitHub-flavored Markdown pipes)
- Links, mentions (`@user`), hashtags (`#tag`)
- `lightbox` originals, `<img>`, Discourse oneboxes (link previews)
- Native emoji images are converted to their text form

## Development

The whole script is a single self-contained IIFE — no bundler, no transpilation. To hack on it:

1. Edit `LDSaver.user.js`.
2. Reload it in your userscript manager (the version string in the header can be bumped to force an update).
3. Hard-refresh a linux.do topic page.

A handful of internal helpers are exposed on `window.__ldExport` for debugging in the browser console: `htmlToMarkdown`, `convert`, `fetchPostsInRange`, `formatTopicMarkdown`, `getJSON`, `exportSingleTopic`, `exportCurrentTopicForPDF`, `markdownToPdf`, `mdToHtml`, `inlineMd`, `detectLang`, `highlight`, `createImageCollector`, `safeName`, `downloadBlob`, `RATE`.

## Caveats

- PDF rendering runs entirely in your browser via `html2pdf.js` (jsPDF + html2canvas). Very long threads or many large images may take a while and use significant memory.
- The script only triggers on `linux.do` (and `*.linux.do`); it does not run on other Discourse instances.
- Defensive rate limiting means exporting a 1000-floor topic will take a while by design — prefer selecting a specific floor range.
- Respect the forum's terms of use and the load you place on its servers.

## License

Provided as-is by the author `albert`. See the `@author` field in the userscript header.

---

<a id="中文"></a>

# LDSaver (中文)

一个 Tampermonkey / Greasemonkey 油猴脚本，用于将 [linux.do](https://linux.do) 论坛帖子导出为 **Markdown** 或 **PDF**，可选打包原始图片为 ZIP。内置代码语法高亮、温和限速以及一个精致的浮动控制面板。

> 版本：1.5.3 · 作者：albert · 命名空间：`https://linux.do/`

## 功能特性

- **导出 Markdown** — 将论坛 HTML 转换为干净的 Markdown（标题、列表、引用、表格、代码块、链接、图片、@提及、#标签、楼层引用、onebox 链接预览）。
- **导出 PDF** — 通过 `html2pdf.js` 将 Markdown 渲染为带样式的 HTML 并输出为 A4 PDF，图片以内联 data URL 形式嵌入，PDF 可独立保存。
- **可选原图打包** — 下载帖子中引用的原始图片，并将 `.md` 文件与图片一起打包成 ZIP；Markdown 中的图片链接指向本地路径。对已经是压缩格式（`png` / `jpg` / `webp` / `gif` / `avif`）的图片采用 STORE 直存，不再二次压缩。
- **代码语法高亮** — 自动识别语言（bash、python、javascript、typescript、go、rust、java、c/cpp、sql、json、html、css 等），为 Markdown 代码块和 PDF 输出都提供 GitHub 暗色风格高亮。
- **楼层范围选择** — 可选「仅主楼」「前 5 楼」「前 10 楼」「前 50 楼」「全部」，也可自定义楼宇范围。
- **YAML frontmatter 与元信息** — 可选在 Markdown 顶部输出 YAML frontmatter，以及帖子元信息（标题、URL、作者、发布时间、标签）。
- **温和限速** — API 与图片请求均带抖动地节流，并具备批次间隔与并发上限；遇 429 会用指数退避按可配次数重试。
- **浮动可拖拽面板** — 苹果风半透明面板，可吸附到屏幕左/右边缘；会记住当前会话内的吸附侧和纵向位置。自动适配明暗模式。
- **零构建** — 单个 `.user.js` 文件；依赖（`html2pdf.js`、`jszip`）在运行时按需从 jsDelivr CDN 加载。

## 安装

1. 安装一个油猴脚本管理器，例如 [Tampermonkey](https://www.tampermonkey.net/)（或 Violentmonkey / Greasemonkey）。
2. 打开 `LDSaver.user.js`，点击 **Raw**（或将该文件直接拖入浏览器中的脚本管理器），然后批准安装。
3. 打开 `https://linux.do/...` 上的任意帖子 — 屏幕左/右边缘会出现一个小把手。点击它即可打开导出面板。

### 可选的 `@require` 模块

脚本通过 `@require` 从 jsDelivr 引入两个库；如果你的脚本管理器支持元数据块，它们会被自动注入：

- `html2pdf.js@0.10.2` — 用于 PDF 渲染。
- `jszip@3.10.1` — 用于带图片的 ZIP 打包。

如果 `@require` 注入被拦截，脚本会在运行时通过 `<script>` 标签懒加载它们。

## 使用方法

1. 进入一个 linux.do 帖子页面，例如 `https://linux.do/t/topic/123`。
2. 点击屏幕边缘的把手，打开 **导出工具** 面板。
3. 通过快捷芯片选择楼层范围（`仅主楼` / `前5楼` / `前10楼` / `前50楼` / `全部`），或自行输入起止楼层。
4. 按需勾选选项：
   - **YAML frontmatter** — 在 Markdown 顶部加入 YAML 元数据块。
   - **帖子元信息** — 在顶部加入引用块，包含原文链接、作者、日期、标签。
   - **每楼楼层头** — 给每一楼加上 `### 第 N 楼 · author (@username) · date` 的标题。
   - **下载图片到本地** — 下载原始图片并与 `.md` 一起打包成 ZIP。不勾选时 Markdown 会直接使用在线图片链接。
5. 点击 **导出 Markdown** 获取 `.md` 文件（如勾选了图片则获取 `.zip`），或 **导出 PDF** 获取自包含的 A4 PDF 文件。

> 面板可通过头部拖动；松手靠近左/右边缘即吸附到对应一侧。

## 限速配置

脚本顶部的 `RATE` 常量控制网络访问的礼貌程度：

| 键名             | 默认值   | 含义                                              |
| ---------------- | -------- | ------------------------------------------------- |
| `apiGap`         | 1000 ms  | API 调用最小间隔（基准）                         |
| `apiJitter`      | 400 ms   | 在 `apiGap` 基础上叠加的随机抖动                 |
| `batchSize`      | 8        | 每个 `/t/<id>/posts.json` 请求拉取的帖子数        |
| `batchGap`       | 1500 ms  | 帖子批次之间的间隔（带抖动）                      |
| `imgGap`         | 280 ms   | 图片下载最小间隔（基准）                         |
| `imgJitter`      | 120 ms   | 在 `imgGap` 基础上叠加的随机抖动                 |
| `imgConcurrency` | 3        | 并发下载图片的工作线程数                          |
| `retries`        | 4        | API 错误时最大重试次数                           |
| `maxImages`      | 120      | 单个帖子最多收集图片数                            |
| `warnFloors`     | 80       | 触发「拉取较慢」提示的楼层范围阈值               |

如果频繁遇到 429 限流，可以适度上调相关参数。

## 使用的接口

脚本读取 `linux.do` 上标准的 Discourse 帖子接口：

- `/t/<topic_id>.json` — 帖子元数据与首批帖子。
- `/t/<topic_id>/posts.json?post_ids[]=...` — 按 id 批量拉取更多帖子。

两者均使用 `credentials: include`，借助你已登录论坛的会话，无需额外认证配置。

## 支持的 HTML 结构

HTML → Markdown 转换器支持：

- 标题（`h1`–`h6`）、段落、`<hr>`、`<br>`
- 行内 `**粗体**`、`*斜体*`、`~~删除线~~`、`` `代码` ``
- 带语言自动识别的代码块
- 有序 / 无序列表，支持嵌套
- 引用块，包括 Discourse 的 `<aside class="quote">` 引用块（带作者与楼层号）
- 表格（GitHub 风格 Markdown 管道语法）
- 链接、@提及（`@user`）、#标签（`#tag`）
- `lightbox` 原图、`<img>`、Discourse onebox（链接预览）
- 原生 emoji 图片被转换为对应的文字形式

## 开发

整个脚本是一个自包含的 IIFE，无需打包器、无需转译。修改步骤：

1. 编辑 `LDSaver.user.js`。
2. 在你的脚本管理器中重新加载（可递增元数据头中的版本号以强制更新）。
3. 强制刷新 linux.do 帖子页面。

少量内部辅助函数被暴露在 `window.__ldExport` 上，便于在浏览器控制台中调试：`htmlToMarkdown`、`convert`、`fetchPostsInRange`、`formatTopicMarkdown`、`getJSON`、`exportSingleTopic`、`exportCurrentTopicForPDF`、`markdownToPdf`、`mdToHtml`、`inlineMd`、`detectLang`、`highlight`、`createImageCollector`、`safeName`、`downloadBlob`、`RATE`。

## 注意事项

- PDF 渲染完全在浏览器中通过 `html2pdf.js`（jsPDF + html2canvas）完成。超长帖或大量大图片时可能耗时较久且占用较多内存。
- 脚本仅在 `linux.do`（及 `*.linux.do`）触发；不会在其他 Discourse 站点运行。
- 限速是有意为之，因此导出 1000 楼的帖子会消耗相当时间 — 建议选择特定楼层范围。
- 请遵守论坛的相关使用条款，并注意你对其服务器造成的负载。

## 许可证

由作者 `albert` 按现状提供。具体见脚本头部的 `@author` 字段。
