# LDSaver

[English](#english) | [中文](#中文)

---

<a id="english"></a>

# LDSaver (English)

Tampermonkey / Greasemonkey userscript that exports [linux.do](https://linux.do) topics to **Markdown**. Forum HTML is converted to clean MD with online image links, floor-range selection, optional frontmatter/meta, language-tagged code fences, gentle API rate limiting, and a dockable floating panel with abort support.

> Version **1.8.2** · Author `albert` · Match `https://linux.do/*` · Single file, no build, no CDN deps

## Features

- **Markdown export** — headings, lists (nested), blockquotes, tables (GFM), fenced code, links, images, `@mentions`, `#hashtags`, Discourse quotes / oneboxes, video placeholders as links, emoji → text
- **Online images only** — lightbox originals preferred; no local download / ZIP
- **Code language detection** — bash, python, javascript/typescript, go, rust, java, c/cpp, sql, json, html, css, dockerfile, vim, … (fence tag only; body stays plain text)
- **Floor range** — chips: first floor / first 5 / 10 / 50 / all, or custom from–to
- **YAML frontmatter** — optional `title`, `url`, `topic_id`, `author`, `created_at`, `tags`
- **Post meta block** — optional blockquote with source URL, author, date, tags
- **Per-floor headers** — optional `### 第 N 楼 · name (@user) · datetime`
- **Abort** — stop mid-export at the next checkpoint (in-flight requests still finish)
- **Rate limiting** — API queue + jitter; post batches with gap; 429 exponential backoff
- **UI** — compact edge handle (default upper-right), drag to dock L/R, light/dark via `light-dark()`

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey / Greasemonkey).
2. Open `LDSaver.user.js` → **Raw** / install, or drop the file into the manager.
3. Open any topic on `linux.do` — a blue-edged handle appears on the screen edge; click to open the panel.

## Usage

1. Open a topic, e.g. `https://linux.do/t/topic/123`.
2. Click the handle → **导出工具**.
3. Pick floor range (chips or inputs).
4. Toggles:
   - **YAML frontmatter**
   - **帖子元信息** (meta blockquote)
   - **每楼楼层头** (per-floor `###` headers)
5. **导出 Markdown** → downloads `safeTitle-topicId.md`.
6. Optional: **终止导出** while running.

Drag the panel header to reposition; release near an edge to dock. Handle defaults ~18% from the top.

## Rate limits (`RATE`)

| Key         | Default | Meaning                                      |
| ----------- | ------- | -------------------------------------------- |
| `apiGap`    | 1000 ms | Min interval between API calls (base)        |
| `apiJitter` | 400 ms  | Random add-on to `apiGap`                    |
| `batchSize` | 8       | Post IDs per `/posts.json` batch             |
| `batchGap`  | 1500 ms | Pause between batches (+ jitter)             |
| `retries`   | 4       | Max retries (incl. HTTP 429 backoff)         |
| `warnFloors`| 80      | Warn when selected floor span is this large  |

## Discourse endpoints

- `GET /t/<id>.json` — topic + initial posts / stream  
- `GET /t/<id>/posts.json?post_ids[]=…` — further posts by id  

Uses `credentials: "include"` (your forum session). No extra auth.

## HTML → Markdown coverage

| Source | Markdown |
| ------ | -------- |
| `h1`–`h6`, `p`, `br`, `hr` | headings, paragraphs, hard breaks, `---` |
| `strong`/`b`, `em`/`i`, `del`/`s`, `code` | `**` `*` `~~` `` ` `` |
| `pre`/`code` | ` ```lang ` fences (`detectLang`) |
| `ul`/`ol` (+ nested) | `-` / `1.` lists |
| `blockquote`, `aside.quote` | `>` quotes (+ author / `#N`) |
| `table` | GFM pipe tables |
| `a`, mention, hashtag | links, bare `@name`, `#tag` |
| `a.lightbox` / `img` | `![alt](original-or-src)` |
| `aside.onebox` | `> [title](url)` + description |
| video placeholders | `[title](url)` when id/url present |
| emoji `<img>` | alt/title text |

## Debug API (`window.__ldExport`)

| Name | Role |
| ---- | ---- |
| `exportSingleTopic` | Full export pipeline |
| `fetchPostsInRange` | Load posts in floor range |
| `formatTopicMarkdown` | Topic + posts → `{ md, filename, … }` |
| `htmlToMarkdown` / `convert` | Cooked HTML → MD |
| `getJSON` | Throttled JSON fetch |
| `detectLang` | Code language guess |
| `newRunToken` / `abortRun` / `checkAbort` | Cancel token |
| `safeName` / `downloadBlob` / `RATE` | Helpers / config |

## Notes

- Only `linux.do` and `*.linux.do`.
- Large floor ranges are intentionally slow; prefer a tight range.
- Images are online links — if the forum CDN later drops them, exported MD loses those images. Mirror yourself for long-term archival.
- Follow the forum ToS and avoid abusive load.

## License

As-is by `albert` (`@author` in the userscript header).

---

<a id="中文"></a>

# LDSaver (中文)

油猴脚本：将 [linux.do](https://linux.do) 帖子导出为 **Markdown**。论坛 HTML 转干净 MD，图片保留在线链接；支持楼层范围、可选 frontmatter/元信息/楼层头、代码语言识别、API 温和限速，以及可拖拽吸附面板与终止导出。

> 版本 **1.8.2** · 作者 `albert` · 匹配 `https://linux.do/*` · 单文件、零构建、无 CDN 依赖

## 功能

- **导出 Markdown** — 标题、嵌套列表、引用、GFM 表格、围栏代码、链接、图片、@提及、#标签、Discourse 引用/onebox、视频占位转链接、emoji 转文字
- **图片仅在线链接** — 优先 lightbox 原图；不下载、不打 ZIP
- **代码语言识别** — bash / python / js·ts / go / rust / java / c·cpp / sql / json / html / css / dockerfile / vim 等（只写 fence 语言标签，正文为纯文本）
- **楼层范围** — 仅主楼 / 前 5·10·50 / 全部，或自定义起止
- **YAML frontmatter** — 可选 `title`、`url`、`topic_id`、`author`、`created_at`、`tags`
- **帖子元信息** — 可选引用块：原文链接、作者、时间、标签
- **每楼楼层头** — 可选 `### 第 N 楼 · 昵称 (@user) · 时间`
- **终止导出** — 下一检查点停止（进行中的请求仍会结束）
- **限速** — API 串行队列 + 抖动；分批拉帖 + 批间隔；429 指数退避重试
- **UI** — 收起态短把手（默认右侧偏上约 18% 视口高）、拖拽吸附左右、`light-dark()` 明暗

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（或 Violentmonkey / Greasemonkey）。
2. 打开 `LDSaver.user.js` 点 **Raw** 安装，或拖入脚本管理器。
3. 打开 linux.do 任意帖子 — 屏幕边缘出现蓝边把手，点击展开面板。

## 使用

1. 进入帖子，如 `https://linux.do/t/topic/123`。
2. 点把手打开 **导出工具**。
3. 用芯片或输入框选楼层。
4. 按需勾选：
   - **YAML frontmatter**
   - **帖子元信息**
   - **每楼楼层头**
5. **导出 Markdown** → 下载 `标题-帖子ID.md`。
6. 导出中可点 **终止导出**。

拖动面板标题栏可换位置；靠近左/右边缘松手即吸附。

## 限速（`RATE`）

| 键 | 默认 | 含义 |
| -- | ---- | ---- |
| `apiGap` | 1000 ms | API 最小间隔（基准） |
| `apiJitter` | 400 ms | 叠加随机抖动 |
| `batchSize` | 8 | 每批 `post_ids` 数量 |
| `batchGap` | 1500 ms | 批次间隔（带抖动） |
| `retries` | 4 | 最大重试（含 429 退避） |
| `warnFloors` | 80 | 楼层跨度达此值时提示较慢 |

## 接口

- `GET /t/<id>.json` — 主题与首批帖 / stream  
- `GET /t/<id>/posts.json?post_ids[]=…` — 按 id 补拉  

`credentials: "include"`，沿用当前登录态。

## HTML → Markdown

与英文表相同：块级/行内样式、代码围栏（`detectLang`）、列表、引用与 `aside.quote`、GFM 表、链接/@/#、lightbox 原图、onebox、视频占位、emoji 文本化。

## 调试 API（`window.__ldExport`）

`exportSingleTopic` · `fetchPostsInRange` · `formatTopicMarkdown` · `htmlToMarkdown` / `convert` · `getJSON` · `detectLang` · `newRunToken` / `abortRun` / `checkAbort` · `safeName` / `downloadBlob` / `RATE`

## 注意

- 仅 `linux.do` / `*.linux.do`。
- 超大楼层范围会故意变慢，建议缩小范围。
- 图片为在线链接 — 若论坛 CDN 日后下架对应文件，导出的 MD 会丢图；需长期存档请自行镜像。
- 请遵守论坛条款，避免对服务器造成过大压力。

## 许可

由 `albert` 按现状提供，见脚本头 `@author`。
