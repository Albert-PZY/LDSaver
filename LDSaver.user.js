// ==UserScript==
// @name         LDSaver
// @namespace    https://linux.do/
// @version      1.8.2
// @description  linux.do 帖子导出 Markdown（图片保留在线链接）、代码语言识别、温和限速
// @author       albert
// @icon         https://picui.ogmua.cn/s1/2026/07/24/6a624ed8b0986.webp
// @match        https://linux.do/*
// @connect      linux.do
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  var RATE = {
    apiGap: 1000,
    apiJitter: 400,
    batchSize: 8,
    batchGap: 1500,
    retries: 4,
    warnFloors: 80
  };

  var currentRun = null;

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  function jitter(base, j) {
    return base + Math.floor(Math.random() * (j + 1));
  }

  function newRunToken() {
    return { aborted: false, reason: "" };
  }

  function abortRun(token, why) {
    if (!token || token.aborted) return;
    token.aborted = true;
    token.reason = why || "用户终止";
  }

  function checkAbort(token) {
    if (token && token.aborted) {
      var e = new Error("已终止" + (token.reason ? "：" + token.reason : ""));
      e.aborted = true;
      throw e;
    }
  }

  function safeName(n) {
    return (
      String(n || "untitled")
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 100) || "untitled"
    );
  }

  function postTime(iso) {
    return String(iso || "")
      .replace("T", " ")
      .replace(/\..*/, "")
      .replace(/Z$/, "");
  }

  function absUrl(u) {
    if (!u) return "";
    try {
      return new URL(u, location.origin).href;
    } catch (_e) {
      return u || "";
    }
  }

  function isEmoji(u) {
    return !u || /\/emoji\/|twemoji|\/images\/emoji/i.test(u);
  }

  function hasClass(node, name) {
    return !!(node && node.classList && node.classList.contains(name));
  }

  function uiCall(ui, method) {
    if (!ui || typeof ui[method] !== "function") return;
    return ui[method].apply(ui, Array.prototype.slice.call(arguments, 2));
  }

  /* ---------- 限速 ---------- */
  var lastApi = 0;
  var apiQ = Promise.resolve();

  function enqueueApi(fn) {
    var run = apiQ
      .then(function () {
        var wait = jitter(RATE.apiGap, RATE.apiJitter) - (Date.now() - lastApi);
        return (wait > 0 ? sleep(wait) : Promise.resolve()).then(function () {
          lastApi = Date.now();
        });
      })
      .then(fn, fn);
    apiQ = run.then(
      function () {},
      function () {}
    );
    return run;
  }

  function downloadBlob(content, filename, mime) {
    var blob =
      content instanceof Blob
        ? content
        : new Blob([content], { type: mime || "text/markdown;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1500);
  }

  function getJSON(url, retries) {
    if (retries == null) retries = RATE.retries;
    return enqueueApi(function () {
      var attempt = 0;
      function once() {
        return fetch(url, {
          headers: {
            Accept: "application/json",
            "X-Requested-With": "XMLHttpRequest"
          },
          credentials: "include"
        }).then(function (r) {
          if (r.status === 429) {
            attempt++;
            if (attempt >= retries) throw new Error("429 重试耗尽: " + url);
            return sleep(8000 * Math.pow(2, attempt - 1) + Math.random() * 2000).then(
              once
            );
          }
          if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
          return r.json();
        }).catch(function (e) {
          if (e && /HTTP |429 /.test(String(e.message || e))) throw e;
          attempt++;
          if (attempt >= retries) throw e || new Error("重试耗尽: " + url);
          return sleep(2000 * attempt).then(once);
        });
      }
      return once();
    });
  }

  /* ---------- 代码语言识别 ---------- */
  var LANG_ALIAS = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    sh: "bash",
    shell: "bash",
    zsh: "bash",
    yml: "yaml",
    rs: "rust",
    "c++": "cpp",
    "c#": "csharp",
    cs: "csharp",
    auto: "",
    text: "",
    plaintext: "",
    none: ""
  };

  function normLang(l) {
    var k = String(l || "")
      .toLowerCase()
      .trim();
    if (Object.prototype.hasOwnProperty.call(LANG_ALIAS, k)) return LANG_ALIAS[k];
    return k.replace(/[^a-z0-9+#.-]/g, "");
  }

  function detectLang(code, className) {
    var m = String(className || "").match(
      /(?:^|\s)(?:lang(?:uage)?-|highlight-)([a-z0-9+#.-]+)/i
    );
    if (m) return normLang(m[1]);

    var s = String(code || "");
    var head = s.slice(0, 800);
    var lines = head.split("\n").slice(0, 40).join("\n");

    if (/^#!\s*\/(?:usr\/)?bin\/(?:env\s+)?(?:ba)?sh\b/m.test(s)) return "bash";
    if (/^#!\s*\/.*python/m.test(s)) return "python";
    if (/^#!\s*\/.*node\b/m.test(s)) return "javascript";
    if (/<\?php/i.test(head)) return "php";
    if (/^\s*package\s+main\b|^\s*func\s+main\s*\(/m.test(lines)) return "go";
    if (/^\s*fn\s+main\s*\(|^\s*use\s+std::/m.test(lines)) return "rust";
    if (
      /System\.out|import\s+java\./.test(s) &&
      /^\s*(public\s+)?(class|interface)\b/m.test(lines)
    ) {
      return "java";
    }
    if (/^\s*#include\s*[<"]/m.test(lines)) {
      return /iostream|std::/.test(s) ? "cpp" : "c";
    }
    if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s+/im.test(lines)) {
      return "sql";
    }
    if (/^\s*\{[\s\S]*"[\w@.-]+"\s*:/.test(head.trim())) return "json";
    if (/^\s*<(!DOCTYPE\s+html|html|svg|div|span)\b/i.test(head.trim())) {
      return "html";
    }
    if (
      /^\s*(\.|#|@media)[\w-]*\s*(\{|,|:)/m.test(lines) &&
      /:\s*[^;{]+;/.test(s)
    ) {
      return "css";
    }
    if (/^\s*(autocmd|func|nnoremap|setlocal)\b/m.test(lines)) return "vim";
    if (/^\s*(FROM|RUN|CMD|COPY|ENV|EXPOSE)\b/m.test(lines)) return "dockerfile";
    if (/^\s*(def |async def |from \w+ import |import \w+)/m.test(lines)) {
      return "python";
    }
    if (
      /^\s*(const |let |var |function |import |export )/m.test(lines) &&
      /[{;=>]/.test(s)
    ) {
      return "javascript";
    }
    if (
      /^\s*(if|for|while|case|elif|fi|done|esac|then|else)\b/m.test(lines) ||
      /^\s*(echo|export|source|sudo|apt|yum|systemctl|chmod|grep|awk|sed|curl|wget|cat|ls)\b/m.test(
        lines
      ) ||
      (/\$\([^)]+\)|`[^`]+`/.test(s) && /\$|echo|bash|\bsh\b/.test(s)) ||
      (/\$[0-9*@#?$!-]/.test(s) && !/function\s*\(|=>|const |let |var /.test(s))
    ) {
      return "bash";
    }
    return "";
  }

  /* ---------- HTML → Markdown ---------- */
  function htmlToMarkdown(html, ctx) {
    if (!html) return "";
    var doc = new DOMParser().parseFromString(
      '<div id="r">' + html + "</div>",
      "text/html"
    );
    return convert(doc.getElementById("r"), ctx || {})
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function kids(node, ctx) {
    var out = "";
    var child = node.childNodes;
    for (var i = 0; i < child.length; i++) out += convert(child[i], ctx);
    return out;
  }

  function quoteLines(inner) {
    if (!inner) return "";
    return inner
      .split("\n")
      .map(function (l) {
        return l.trim() === "" ? ">" : "> " + l;
      })
      .join("\n");
  }

  function convert(node, ctx) {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    var tag = node.tagName.toLowerCase();
    var ch = function () {
      return kids(node, ctx);
    };

    switch (tag) {
      case "br":
        return "  \n";
      case "hr":
        return "\n\n---\n\n";
      case "p":
        return "\n\n" + ch() + "\n\n";
      case "strong":
      case "b":
        return "**" + ch() + "**";
      case "em":
      case "i":
        return "*" + ch() + "*";
      case "del":
      case "s":
        return "~~" + ch() + "~~";
      case "code": {
        if (node.parentElement && node.parentElement.tagName === "PRE") {
          return ch();
        }
        var t = node.textContent || "";
        var q = t.indexOf("`") >= 0 ? "``" : "`";
        return q + t + q;
      }
      case "pre": {
        var code = node.querySelector("code");
        var raw = ((code || node).textContent || "").replace(/\n+$/, "");
        var lang = detectLang(raw, (code || node).className || "");
        return "\n\n```" + lang + "\n" + raw + "\n```\n\n";
      }
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return (
          "\n\n" +
          new Array(+tag[1] + 1).join("#") +
          " " +
          ch().replace(/\s+/g, " ").trim() +
          "\n\n"
        );
      case "ul":
        return "\n" + list(node, ctx, false) + "\n";
      case "ol":
        return "\n" + list(node, ctx, true) + "\n";
      case "blockquote":
        return "\n" + quoteLines(ch().trim()) + "\n";
      case "a":
        return convertA(node, ctx);
      case "img":
        return convertImg(node);
      case "table":
        return convertTable(node, ctx);
      case "thead":
      case "tbody":
      case "tr":
      case "th":
      case "td":
        return ch();
      case "svg":
      case "use":
      case "button":
      case "script":
      case "style":
      case "noscript":
        return "";
      case "aside":
        return convertAsideLike(node, ctx);
      default:
        if (hasClass(node, "onebox") || hasClass(node, "quote")) {
          return convertAsideLike(node, ctx);
        }
        if (isVideoPlaceholder(node)) return convertVideo(node);
        return ch();
    }
  }

  function convertAsideLike(node, ctx) {
    if (hasClass(node, "onebox")) return convertOnebox(node);
    if (hasClass(node, "quote")) return convertQuote(node, ctx);
    return kids(node, ctx);
  }

  function isVideoPlaceholder(node) {
    if (!node.classList) return false;
    var cl = String(node.className || "");
    return (
      hasClass(node, "video-placeholder-container") ||
      hasClass(node, "video-container") ||
      hasClass(node, "video-placeholder") ||
      hasClass(node, "youtube-onebox") ||
      hasClass(node, "vimeo-onebox") ||
      /\b(play.?button|video-placeholder|iframe-container)\b/i.test(cl)
    );
  }

  function convertVideo(node) {
    var vsrc =
      node.getAttribute("data-video-id") ||
      node.getAttribute("data-video-url") ||
      node.getAttribute("data-original-href") ||
      "";
    if (!vsrc) return "\n\n";
    var title = (node.getAttribute("data-title") || "").trim() || "视频";
    return "\n\n[" + title + "](" + absUrl(String(vsrc)) + ")\n\n";
  }

  function list(node, ctx, ordered) {
    var start = parseInt(node.getAttribute("start") || "1", 10) || 1;
    var items = [];
    var children = node.children;
    for (var i = 0; i < children.length; i++) {
      if (children[i].tagName !== "LI") continue;
      var li = children[i];
      var body = "";
      var nest = "";
      var nodes = li.childNodes;
      for (var k = 0; k < nodes.length; k++) {
        var n = nodes[k];
        if (n.nodeType === 1 && (n.tagName === "UL" || n.tagName === "OL")) {
          nest +=
            "\n" +
            list(n, ctx, n.tagName === "OL").replace(/^/gm, "  ");
        } else {
          body += convert(n, ctx);
        }
      }
      var marker = ordered ? start + items.length + "." : "-";
      items.push(marker + " " + body.trim() + nest);
    }
    return items.join("\n");
  }

  function convertA(node, ctx) {
    var href = node.getAttribute("href") || "";
    if (hasClass(node, "anchor")) return "";
    if (hasClass(node, "mention")) return node.textContent.trim();

    if (hasClass(node, "hashtag") || hasClass(node, "hashtag-cooked")) {
      var spans = node.querySelectorAll("span");
      var name = "";
      for (var i = 0; i < spans.length; i++) {
        var tx = spans[i].textContent.trim();
        if (tx) name = tx;
      }
      return "#" + (name || node.textContent.trim());
    }

    if (hasClass(node, "lightbox")) {
      var img = node.querySelector("img");
      var alt = (
        (img && img.getAttribute("alt")) ||
        node.getAttribute("title") ||
        "image"
      ).trim();
      var original = absUrl(href || "");
      var optimized = absUrl(
        (img && (img.getAttribute("src") || img.getAttribute("data-src"))) || ""
      );
      return "![" + alt + "](" + (original || optimized) + ")";
    }

    var text = kids(node, ctx).trim() || href;
    if (!href || href.charAt(0) === "#") return text;
    return "[" + text + "](" + href + ")";
  }

  function convertImg(node) {
    if (hasClass(node, "emoji")) {
      return node.getAttribute("title") || node.getAttribute("alt") || "";
    }
    if (hasClass(node.parentElement, "lightbox")) return "";

    var src =
      node.getAttribute("data-orig-src") ||
      node.getAttribute("src") ||
      node.getAttribute("data-src") ||
      "";
    var online = absUrl(src);
    if (!online || isEmoji(online)) {
      return (node.getAttribute("alt") || "").trim();
    }
    var alt = (node.getAttribute("alt") || "").trim() || "image";
    return "![" + alt + "](" + online + ")";
  }

  function convertTable(node, ctx) {
    var trs = node.querySelectorAll("tr");
    var rows = [];
    var cols = 0;
    for (var i = 0; i < trs.length; i++) {
      var cells = [];
      var kidsEl = trs[i].children;
      for (var j = 0; j < kidsEl.length; j++) {
        if (kidsEl[j].tagName === "TH" || kidsEl[j].tagName === "TD") {
          cells.push(
            kids(kidsEl[j], ctx)
              .replace(/\s+/g, " ")
              .trim()
              .replace(/\|/g, "\\|")
          );
        }
      }
      if (cells.length > cols) cols = cells.length;
      rows.push(cells);
    }
    if (!rows.length) return "";
    for (var r = 0; r < rows.length; r++) {
      while (rows[r].length < cols) rows[r].push("");
    }
    var lines = ["| " + rows[0].join(" | ") + " |"];
    lines.push(
      "| " +
        rows[0]
          .map(function () {
            return "---";
          })
          .join(" | ") +
        " |"
    );
    for (var r3 = 1; r3 < rows.length; r3++) {
      lines.push("| " + rows[r3].join(" | ") + " |");
    }
    return "\n\n" + lines.join("\n") + "\n\n";
  }

  function convertOnebox(node) {
    var src = node.getAttribute("data-onebox-src") || "";
    var title = src;
    var h3 = node.querySelector("h3 a, h3");
    if (h3) title = h3.textContent.trim();
    else {
      var a = node.querySelector(".onebox-body a[href]");
      if (a) title = a.textContent.trim();
    }
    var descEl = node.querySelector(
      ".github-repo-description, .onebox-description"
    );
    var desc = descEl ? descEl.textContent.trim() : "";
    return (
      "\n> [" +
      title +
      "](" +
      src +
      ")\n" +
      (desc ? "> " + desc + "\n" : "") +
      "\n"
    );
  }

  function convertQuote(node, ctx) {
    var num = node.getAttribute("data-post") || "";
    var titleEl = node.querySelector(".title");
    var author = "";
    if (titleEl) {
      var c = titleEl.cloneNode(true);
      var controls = c.querySelector(".quote-controls");
      if (controls) controls.remove();
      author = c.textContent
        .replace(/[:：\s]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }
    var bq = node.querySelector("blockquote");
    var inner = bq ? kids(bq, ctx) : "";
    var head = author
      ? "**" + author + "**" + (num ? " （#" + num + "）" : "")
      : num
        ? "（#" + num + "）"
        : "";
    return "\n" + (head ? "> " + head + "\n" : "") + quoteLines(inner) + "\n";
  }

  /* ---------- API ---------- */
  function fetchPostsInRange(topicId, from, to, onProgress, token) {
    checkAbort(token);
    return getJSON("/t/" + topicId + ".json").then(function (base) {
      var stream = (base.post_stream && base.post_stream.stream) || [];
      var initial = (base.post_stream && base.post_stream.posts) || [];
      var map = {};
      var loaded = {};
      for (var i = 0; i < initial.length; i++) {
        map[initial[i].post_number] = initial[i];
        loaded[initial[i].id] = true;
      }

      var need = [];
      var slice = stream.slice(0, Math.max(to, from));
      for (var s = 0; s < slice.length; s++) {
        if (!loaded[slice[s]]) need.push(slice[s]);
      }

      function loadBatch(start) {
        checkAbort(token);
        if (start >= need.length) return Promise.resolve();
        var batch = need.slice(start, start + RATE.batchSize);
        var params = batch
          .map(function (id) {
            return "post_ids[]=" + id;
          })
          .join("&");
        return getJSON("/t/" + topicId + "/posts.json?" + params).then(
          function (j) {
            var posts = (j.post_stream && j.post_stream.posts) || [];
            for (var p = 0; p < posts.length; p++) {
              map[posts[p].post_number] = posts[p];
            }
            if (onProgress) {
              onProgress(
                Math.min(start + batch.length, need.length),
                need.length
              );
            }
            if (start + RATE.batchSize < need.length) {
              return sleep(jitter(RATE.batchGap, 400)).then(function () {
                return loadBatch(start + RATE.batchSize);
              });
            }
          }
        );
      }

      return loadBatch(0).then(function () {
        var nums = [];
        for (var key in map) {
          if (Object.prototype.hasOwnProperty.call(map, key)) {
            var n = +key;
            if (n >= from && n <= to) nums.push(n);
          }
        }
        nums.sort(function (a, b) {
          return a - b;
        });
        return {
          topic: base,
          posts: nums
            .map(function (n) {
              return map[n];
            })
            .filter(Boolean)
        };
      });
    });
  }

  function formatTopicMarkdown(topic, posts, opts) {
    var title = topic.title || topic.fancy_title || "无标题";
    var id = topic.id;
    var url = "https://linux.do/t/" + (topic.slug || "topic") + "/" + id;
    var tags = [];
    if (Array.isArray(topic.tags)) {
      for (var ti = 0; ti < topic.tags.length; ti++) {
        var tg = topic.tags[ti];
        tags.push(typeof tg === "string" ? tg : tg.name);
      }
      tags = tags.filter(Boolean);
    }
    var author0 =
      (posts[0] && (posts[0].display_username || posts[0].username)) || "";
    var created = postTime(topic.created_at);
    var md = "";

    if (opts.includeFrontmatter) {
      md +=
        "---\n" +
        'title: "' +
        title.replace(/"/g, '\\"') +
        '"\n' +
        "url: " +
        url +
        "\n" +
        "topic_id: " +
        id +
        "\n" +
        'author: "' +
        author0.replace(/"/g, '\\"') +
        '"\n' +
        (created ? "created_at: " + created + "\n" : "") +
        (tags.length ? "tags: [" + tags.join(", ") + "]\n" : "") +
        "---\n\n";
    }

    md += "# " + title + "\n\n";
    if (opts.includeMeta) {
      md += "> 原文链接：" + url + "\n";
      if (author0) md += "> 作者：" + author0 + "\n";
      if (created) md += "> 发布：" + created + "\n";
      if (tags.length) {
        md +=
          "> 标签：" +
          tags
            .map(function (t) {
              return "#" + t;
            })
            .join(" ") +
          "\n";
      }
      md += "\n";
    }

    var parts = [];
    for (var pi = 0; pi < posts.length; pi++) {
      var p = posts[pi];
      var body = htmlToMarkdown(p.cooked || "");
      if (!opts.includeFloorHeader) {
        parts.push(body);
        continue;
      }
      var author = p.display_username || p.name || p.username || "匿名";
      var user = p.username ? " (@" + p.username + ")" : "";
      var date = postTime(p.created_at);
      parts.push(
        "### 第 " +
          p.post_number +
          " 楼 · " +
          author +
          user +
          (date ? " · " + date : "") +
          "\n\n" +
          body
      );
    }
    md += parts.join("\n\n---\n\n") + "\n";

    return {
      md: md,
      filename: safeName(title) + "-" + id + ".md",
      title: title,
      url: url,
      topicId: id
    };
  }

  function exportSingleTopic(topicId, opts, ui, token) {
    checkAbort(token);
    var range = (opts.toFloor || 1) - (opts.fromFloor || 1) + 1;
    uiCall(ui, "log", "导出帖子 " + topicId + "...");
    uiCall(ui, "setStage", "拉取帖子");
    if (range >= RATE.warnFloors) {
      uiCall(ui, "log", "楼层范围约 " + range + "，温和拉取中...", "warn");
    }

    return fetchPostsInRange(
      topicId,
      opts.fromFloor,
      opts.toFloor,
      function (d, t) {
        uiCall(ui, "progress", 0.05 + (0.7 * d) / Math.max(t, 1));
      },
      token
    ).then(function (data) {
      checkAbort(token);
      uiCall(ui, "setStage", "生成 Markdown");
      uiCall(ui, "progress", 0.85);
      var r = formatTopicMarkdown(data.topic, data.posts, opts);
      downloadBlob(r.md, r.filename);
      uiCall(ui, "progress", 1);
      uiCall(ui, "setStage", "完成");
      uiCall(
        ui,
        "log",
        "✓ 已下载 " +
          r.filename +
          "（" +
          data.posts.length +
          " 楼，图片为在线链接）",
        "ok"
      );
      return { type: "md", filename: r.filename, size: r.md.length };
    });
  }

  /* ---------- UI ---------- */
  var dock = { side: "right", y: null, open: false };

  var UI_CSS =
    "#ld-panel,#ld-handle{color-scheme:light dark;font:13px/1.4 system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;" +
    "-webkit-font-smoothing:antialiased;--fg:rgba(0,0,0,.9);--sub:rgba(0,0,0,.6);" +
    "--in:rgba(255,255,255,.7);--inf:rgba(255,255,255,.98);--q:rgba(0,0,0,.05);--qh:rgba(0,0,0,.09);" +
    "--log:rgba(0,0,0,.05);--tr:rgba(0,0,0,.08)}" +
    "@media(prefers-color-scheme:dark){#ld-panel,#ld-handle{--fg:rgba(255,255,255,.9);--sub:rgba(255,255,255,.6);" +
    "--in:rgba(255,255,255,.1);--inf:rgba(255,255,255,.16);--q:rgba(255,255,255,.1);--qh:rgba(255,255,255,.15);" +
    "--log:rgba(0,0,0,.35);--tr:rgba(255,255,255,.1)}}" +
    "#ld-handle{position:fixed;z-index:2147483646;width:20px;height:88px;" +
    "background:light-dark(#fff,rgba(28,28,30,.88));border:1.5px solid light-dark(#0071e3,rgba(10,132,255,.55));" +
    "box-shadow:light-dark(0 0 0 1px rgba(0,113,227,.12),0 2px 6px rgba(0,0,0,.12),0 6px 20px rgba(0,113,227,.22),0 12px 32px rgba(0,0,0,.14)," +
    "0 2px 10px rgba(0,0,0,.55),0 0 0 1px rgba(10,132,255,.25));" +
    "-webkit-backdrop-filter:saturate(1.6) blur(16px);backdrop-filter:saturate(1.6) blur(16px);border-radius:12px;cursor:grab;" +
    "display:flex;align-items:center;justify-content:center;user-select:none;touch-action:none;" +
    "transition:width .25s cubic-bezier(.4,0,.2,1),box-shadow .25s,border-color .2s}" +
    "#ld-handle:hover{width:26px;border-color:light-dark(#0060c0,#0a84ff);" +
    "box-shadow:light-dark(0 0 0 2px rgba(0,113,227,.2),0 4px 12px rgba(0,0,0,.14),0 10px 28px rgba(0,113,227,.32)," +
    "0 4px 18px rgba(0,0,0,.6),0 0 0 2px rgba(10,132,255,.4))}" +
    "#ld-handle:active{cursor:grabbing}" +
    "#ld-handle::before{content:'';width:3px;height:28px;border-radius:3px;" +
    "background:light-dark(#0071e3,rgba(255,255,255,.7))}" +
    "#ld-handle.ld-left{left:0;border-radius:0 12px 12px 0;border-left:0;" +
    "box-shadow:light-dark(2px 0 0 rgba(0,113,227,.15),4px 2px 12px rgba(0,0,0,.12),8px 4px 24px rgba(0,113,227,.2),4px 0 16px rgba(0,0,0,.5))}" +
    "#ld-handle.ld-right{right:0;border-radius:12px 0 0 12px;border-right:0;" +
    "box-shadow:light-dark(-2px 0 0 rgba(0,113,227,.15),-4px 2px 12px rgba(0,0,0,.12),-8px 4px 24px rgba(0,113,227,.2),-4px 0 16px rgba(0,0,0,.5))}" +
    "#ld-handle.ld-left:hover{box-shadow:light-dark(2px 0 0 rgba(0,113,227,.28),6px 4px 18px rgba(0,0,0,.14),12px 6px 32px rgba(0,113,227,.28),6px 0 20px rgba(0,0,0,.55))}" +
    "#ld-handle.ld-right:hover{box-shadow:light-dark(-2px 0 0 rgba(0,113,227,.28),-6px 4px 18px rgba(0,0,0,.14),-12px 6px 32px rgba(0,113,227,.28),-6px 0 20px rgba(0,0,0,.55))}" +
    "#ld-handle.ld-hidden{display:none}" +
    "#ld-panel{position:fixed;z-index:2147483647;width:340px;max-height:88vh;" +
    "background:light-dark(#fff,rgba(28,28,30,.9));border:1.5px solid light-dark(rgba(0,113,227,.35),rgba(10,132,255,.35));" +
    "box-shadow:light-dark(0 0 0 1px rgba(0,113,227,.08),0 4px 16px rgba(0,0,0,.1),0 12px 40px rgba(0,113,227,.16),0 24px 64px rgba(0,0,0,.12)," +
    "0 8px 32px rgba(0,0,0,.55),0 0 0 1px rgba(10,132,255,.2));" +
    "-webkit-backdrop-filter:saturate(1.6) blur(16px);backdrop-filter:saturate(1.6) blur(16px);color:var(--fg);border-radius:28px;" +
    "display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:scale(.94);pointer-events:none;" +
    "transition:transform .4s cubic-bezier(.4,0,.2,1),opacity .3s}" +
    "#ld-panel.ld-open{opacity:1;transform:scale(1);pointer-events:auto}" +
    "#ld-panel.ld-dragging{transition:none!important}#ld-panel.ld-dragging *{pointer-events:none}#ld-panel.ld-dragging .ld-head{pointer-events:auto}" +
    ".ld-head{padding:18px 20px 14px;display:flex;align-items:center;gap:10px;cursor:grab;user-select:none;touch-action:none}" +
    ".ld-head:active{cursor:grabbing}.ld-head-title{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}" +
    ".ld-head-title b{font-size:15px;font-weight:600}.ld-head-title small{font-size:11px;color:var(--sub)}" +
    ".ld-drag-dots{display:flex;flex-direction:column;gap:3px;opacity:.45;margin-right:2px}" +
    ".ld-drag-dots span{display:flex;gap:2px}.ld-drag-dots i{width:3px;height:3px;border-radius:50%;background:var(--sub);display:block}" +
    ".ld-close{width:28px;height:28px;border:0;border-radius:50%;cursor:pointer;background:var(--q);color:var(--sub);font-size:15px;" +
    "display:flex;align-items:center;justify-content:center}.ld-close:hover{background:var(--qh)}" +
    ".ld-body{padding:14px 20px 20px;overflow-y:auto;flex:1;scrollbar-width:thin;scrollbar-color:rgba(0,113,227,.35) transparent}" +
    ".ld-body::-webkit-scrollbar{width:7px}.ld-body::-webkit-scrollbar-thumb{background:rgba(0,113,227,.4);border-radius:8px}" +
    ".ld-row{margin-bottom:16px}.ld-row>label{display:block;font-weight:600;margin-bottom:7px;font-size:12px}" +
    ".ld-row .hint{color:var(--sub);font-size:11px;margin-top:5px;line-height:1.5}" +
    ".ld-floor{display:flex;align-items:center;gap:7px;flex-wrap:wrap}" +
    ".ld-floor input[type=number]{width:64px;padding:7px 9px;font-size:13px;font-weight:500;background:var(--in);border:0;border-radius:10px;color:var(--fg)}" +
    ".ld-floor input:focus{outline:0;background:var(--inf);box-shadow:0 0 0 3px rgba(0,113,227,.2)}" +
    ".ld-floor span{color:var(--sub);font-size:12px}" +
    ".ld-topic-info{padding:11px 13px;border-radius:10px;background:var(--q)}" +
    ".ld-topic-title{font-size:13px;font-weight:600;word-break:break-word}.ld-topic-meta{font-size:11px;color:var(--sub);margin-top:4px}" +
    ".ld-topic-info.ld-nope .ld-topic-title{color:var(--sub);font-weight:500}" +
    ".ld-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}" +
    ".ld-chip{padding:6px 13px;border-radius:16px;font-size:12px;font-weight:500;cursor:pointer;background:var(--q);color:var(--sub);user-select:none}" +
    ".ld-chip:hover{background:var(--qh);color:var(--fg)}.ld-chip.active{background:#0071e3;color:#fff;font-weight:600}" +
    ".ld-check{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 0}" +
    ".ld-check label{margin:0;font-weight:400;font-size:13px;cursor:pointer;flex:1}" +
    ".ld-check input{margin:0;width:18px;height:18px;accent-color:#0071e3;cursor:pointer}" +
    ".ld-btns{display:flex;gap:10px;margin-top:14px}" +
    ".ld-btn{flex:1;padding:11px 14px;border:0;border-radius:14px;cursor:pointer;font-size:13px;font-weight:600;" +
    "transition:transform .12s,opacity .15s,background .18s;background:#0071e3;color:#fff}" +
    ".ld-btn:hover{background:#0077ed}.ld-btn:active{transform:scale(.97)}" +
    ".ld-btn:disabled{opacity:.5;cursor:not-allowed;transform:none!important}" +
    ".ld-stop-wrap{margin-top:10px;display:flex}.ld-stop-wrap[hidden]{display:none}" +
    ".ld-btn-stop{flex:1;padding:9px 14px;border:0;border-radius:12px;cursor:pointer;font-size:12.5px;font-weight:600;background:#ff3b30;color:#fff}" +
    ".ld-btn-stop:hover{background:#ff453a}.ld-btn-stop:disabled{opacity:.5;cursor:not-allowed}" +
    ".ld-progress-wrap{margin-top:14px}" +
    ".ld-progress-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px;min-height:16px}" +
    ".ld-progress-stage{font-size:11px;font-weight:500;color:var(--sub);display:flex;align-items:center;gap:6px}" +
    ".ld-progress-stage .ld-spin{width:10px;height:10px;border:1.5px solid rgba(0,113,227,.25);border-top-color:#0071e3;border-radius:50%;display:none;animation:ld-spin .7s linear infinite}" +
    ".ld-progress-wrap.ld-busy .ld-spin{display:inline-block}" +
    ".ld-progress-pct{font-size:11px;font-weight:600;color:#0071e3;font-variant-numeric:tabular-nums;min-width:36px;text-align:right}" +
    ".ld-progress{height:6px;background:var(--tr);border-radius:99px;overflow:hidden;position:relative}" +
    ".ld-progress-bar{height:100%;width:0%;border-radius:99px;background:linear-gradient(90deg,#0071e3,#34a4ff 55%,#0071e3);" +
    "background-size:200% 100%;transition:width .28s cubic-bezier(.4,0,.2,1);box-shadow:0 0 10px rgba(0,113,227,.25)}" +
    ".ld-progress-wrap.ld-busy .ld-progress-bar{animation:ld-shimmer 1.4s linear infinite}" +
    "@keyframes ld-shimmer{0%{background-position:100% 0}100%{background-position:-100% 0}}" +
    "@keyframes ld-spin{to{transform:rotate(360deg)}}" +
    ".ld-log{margin-top:12px;padding:10px 12px;border-radius:12px;background:var(--log);color:var(--fg);" +
    "font:11.5px/1.65 ui-monospace,Consolas,monospace;max-height:160px;overflow-y:auto;white-space:pre-wrap;word-break:break-all}" +
    ".ld-log .err{color:#ff6961}.ld-log .warn{color:#ffd60a}.ld-log .ok{color:#30d158}";

  function injectUI() {
    if (document.getElementById("ld-panel")) return;

    var style = document.createElement("style");
    style.textContent = UI_CSS;
    document.head.appendChild(style);

    var handle = document.createElement("div");
    handle.id = "ld-handle";
    handle.title = "拖动改变位置，点击展开";

    var panel = document.createElement("div");
    panel.id = "ld-panel";
    panel.innerHTML =
      '<div class="ld-head" id="ld-head">' +
      '<div class="ld-drag-dots"><span><i></i><i></i><i></i></span><span><i></i><i></i><i></i></span></div>' +
      '<div class="ld-head-title"><b>导出工具</b><small>LINUX DO · Markdown</small></div>' +
      '<button class="ld-close" id="ld-close" title="收起" type="button">×</button></div>' +
      '<div class="ld-body">' +
      '<div class="ld-row"><label>当前帖子</label>' +
      '<div class="ld-topic-info" id="ld-topic-info">' +
      '<div class="ld-topic-title" id="ld-topic-title">检测中...</div>' +
      '<div class="ld-topic-meta" id="ld-topic-meta"></div></div></div>' +
      '<div class="ld-row"><label>楼层范围</label>' +
      '<div class="ld-floor">' +
      '<input type="number" id="ld-from" value="1" min="1"><span>楼 至</span>' +
      '<input type="number" id="ld-to" value="1" min="1"><span>楼</span></div>' +
      '<div class="hint">图片保留为在线链接，不下载到本地</div>' +
      '<div class="ld-chips">' +
      '<span class="ld-chip active" data-from="1" data-to="1">仅主楼</span>' +
      '<span class="ld-chip" data-from="1" data-to="5">前5楼</span>' +
      '<span class="ld-chip" data-from="1" data-to="10">前10楼</span>' +
      '<span class="ld-chip" data-from="1" data-to="50">前50楼</span>' +
      '<span class="ld-chip" data-from="1" data-to="99999">全部</span></div></div>' +
      '<div class="ld-row ld-check"><label for="ld-frontmatter">YAML frontmatter</label><input type="checkbox" id="ld-frontmatter" checked></div>' +
      '<div class="ld-row ld-check"><label for="ld-meta">帖子元信息</label><input type="checkbox" id="ld-meta" checked></div>' +
      '<div class="ld-row ld-check"><label for="ld-floorhdr">每楼楼层头</label><input type="checkbox" id="ld-floorhdr" checked></div>' +
      '<div class="ld-btns"><button class="ld-btn" id="ld-export-md" type="button">导出 Markdown</button></div>' +
      '<div class="ld-stop-wrap" id="ld-stop-wrap" hidden><button class="ld-btn-stop" id="ld-export-stop" type="button">终止导出</button></div>' +
      '<div class="ld-progress-wrap" id="ld-progress-wrap">' +
      '<div class="ld-progress-meta">' +
      '<div class="ld-progress-stage"><span class="ld-spin"></span><span id="ld-progress-stage">就绪</span></div>' +
      '<div class="ld-progress-pct" id="ld-progress-pct">0%</div></div>' +
      '<div class="ld-progress"><div class="ld-progress-bar" id="ld-progress-bar"></div></div></div>' +
      '<div class="ld-log" id="ld-log"></div></div>';

    document.body.appendChild(handle);
    document.body.appendChild(panel);

    function clampY(y) {
      return Math.max(10, Math.min(y, window.innerHeight - 100));
    }

    function applyDock() {
      // 默认贴右侧偏上（约 18% 视口高），比原先 30% 更靠上
      var y = clampY(dock.y != null ? dock.y : window.innerHeight * 0.18);
      handle.style.top = y + "px";
      handle.style.left = "";
      handle.style.right = "";
      handle.classList.toggle("ld-left", dock.side === "left");
      handle.classList.toggle("ld-right", dock.side !== "left");
      panel.style.top = y + "px";
      if (dock.side === "left") {
        panel.style.left = "0px";
        panel.style.right = "auto";
      } else {
        panel.style.right = "0px";
        panel.style.left = "auto";
      }
    }

    function open() {
      dock.open = true;
      panel.classList.add("ld-open");
      handle.classList.add("ld-hidden");
    }

    function close() {
      dock.open = false;
      panel.classList.remove("ld-open");
      handle.classList.remove("ld-hidden");
    }

    applyDock();

    function bindDrag(el, trigger, opts) {
      var on = false;
      var sx = 0;
      var sy = 0;
      var ox = 0;
      var oy = 0;
      var moved = false;

      trigger.addEventListener("pointerdown", function (e) {
        if (e.target.closest(".ld-close,button")) return;
        on = true;
        moved = false;
        sx = e.clientX;
        sy = e.clientY;
        var r = el.getBoundingClientRect();
        ox = r.left;
        oy = r.top;
        el.classList.add("ld-dragging");
        el.classList.remove("ld-left", "ld-right");
        el.style.left = ox + "px";
        el.style.right = "auto";
        el.style.top = oy + "px";
        trigger.setPointerCapture(e.pointerId);
        e.preventDefault();
      });

      trigger.addEventListener("pointermove", function (e) {
        if (!on) return;
        var dx = e.clientX - sx;
        var dy = e.clientY - sy;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
        el.style.left =
          Math.max(0, Math.min(ox + dx, window.innerWidth - el.offsetWidth)) +
          "px";
        el.style.top = clampY(oy + dy) + "px";
        el.style.right = "auto";
        dock.y = clampY(oy + dy);
      });

      function end(e) {
        if (!on) return;
        on = false;
        el.classList.remove("ld-dragging");
        try {
          trigger.releasePointerCapture(e.pointerId);
        } catch (_e) {}
        if (!moved) {
          if (opts.onClick) opts.onClick();
          return;
        }
        var r = el.getBoundingClientRect();
        dock.side =
          r.left + r.width / 2 < window.innerWidth / 2 ? "left" : "right";
        if (opts.onDock) opts.onDock();
      }

      trigger.addEventListener("pointerup", end);
      trigger.addEventListener("pointercancel", function () {
        on = false;
        el.classList.remove("ld-dragging");
        if (opts.onDock) opts.onDock();
      });
    }

    bindDrag(panel, document.getElementById("ld-head"), { onDock: applyDock });
    bindDrag(handle, handle, { onClick: open, onDock: applyDock });
    document.getElementById("ld-close").onclick = close;
    window.addEventListener("resize", applyDock);

    var chips = panel.querySelectorAll(".ld-chip");
    for (var ci = 0; ci < chips.length; ci++) {
      chips[ci].onclick = (function (chip) {
        return function () {
          document.getElementById("ld-from").value = chip.getAttribute(
            "data-from"
          );
          document.getElementById("ld-to").value = chip.getAttribute("data-to");
          for (var j = 0; j < chips.length; j++) {
            chips[j].classList.toggle("active", chips[j] === chip);
          }
        };
      })(chips[ci]);
    }

    var logEl = document.getElementById("ld-log");
    var barEl = document.getElementById("ld-progress-bar");
    var wrapEl = document.getElementById("ld-progress-wrap");
    var stageEl = document.getElementById("ld-progress-stage");
    var pctEl = document.getElementById("ld-progress-pct");
    var stopWrap = document.getElementById("ld-stop-wrap");
    var stopBtn = document.getElementById("ld-export-stop");
    var exportBtn = document.getElementById("ld-export-md");
    var busy = false;

    var ui = {
      log: function (msg, type) {
        var line = document.createElement("div");
        if (type === "error") line.className = "err";
        else if (type === "warn") line.className = "warn";
        else if (type === "ok") line.className = "ok";
        line.textContent = msg;
        logEl.appendChild(line);
        logEl.scrollTop = logEl.scrollHeight;
      },
      setBusy: function (on) {
        wrapEl.classList.toggle("ld-busy", !!on);
        if (!on) stageEl.textContent = "就绪";
      },
      setStage: function (text) {
        if (text != null) stageEl.textContent = text;
      },
      setProgress: function (pct) {
        var n = Math.max(0, Math.min(100, pct <= 1 ? pct * 100 : pct));
        barEl.style.width = n + "%";
        pctEl.textContent = Math.round(n) + "%";
      },
      progress: function (r) {
        this.setProgress((r || 0) * 100);
      },
      resetProgress: function () {
        this.setProgress(0);
        this.setStage("就绪");
        this.setBusy(false);
      }
    };

    function currentTopic() {
      var m = location.pathname.match(/\/t\/(?:[^/]+\/)?(\d+)/);
      if (!m) return null;
      var titleEl = document.querySelector(
        "#topic-title h1, .fancy-title, .topic-title"
      );
      var title = titleEl ? titleEl.textContent.trim() : "";
      if (!title) {
        title =
          document.title.replace(/\s*-\s*LINUX DO.*$/i, "").trim() ||
          "帖子 " + m[1];
      }
      return { topicId: m[1], title: title };
    }

    function refresh() {
      var t = currentTopic();
      var info = document.getElementById("ld-topic-info");
      var titleEl = document.getElementById("ld-topic-title");
      var metaEl = document.getElementById("ld-topic-meta");
      if (t) {
        info.classList.remove("ld-nope");
        titleEl.textContent = t.title;
        metaEl.textContent = "ID: " + t.topicId;
      } else {
        info.classList.add("ld-nope");
        titleEl.textContent = "当前页面不是帖子详情页";
        metaEl.textContent = "请打开一个帖子后再导出";
      }
    }

    refresh();
    var lastHref = location.href;
    setInterval(function () {
      if (location.href !== lastHref) {
        lastHref = location.href;
        refresh();
      }
    }, 800);

    function readOpts() {
      var from = parseInt(document.getElementById("ld-from").value, 10) || 1;
      var to = parseInt(document.getElementById("ld-to").value, 10) || 1;
      if (to < from) to = from;
      return {
        fromFloor: from,
        toFloor: to,
        includeFrontmatter: document.getElementById("ld-frontmatter").checked,
        includeMeta: document.getElementById("ld-meta").checked,
        includeFloorHeader: document.getElementById("ld-floorhdr").checked
      };
    }

    function runExport() {
      if (busy) {
        ui.log("已有导出任务进行中", "warn");
        return;
      }
      var t = currentTopic();
      if (!t) {
        ui.log("当前页面不是帖子详情页", "error");
        return;
      }

      logEl.innerHTML = "";
      ui.resetProgress();
      ui.setBusy(true);
      ui.setStage("准备导出 Markdown");
      busy = true;
      exportBtn.disabled = true;

      var token = newRunToken();
      currentRun = { token: token };
      stopBtn.disabled = false;
      stopBtn.textContent = "终止导出";
      stopWrap.hidden = false;

      Promise.resolve(exportSingleTopic(t.topicId, readOpts(), ui, token))
        .catch(function (e) {
          if (e && e.aborted) {
            ui.log(
              "已终止" + (e.message ? "：" + e.message : "") + "，可重新发起导出",
              "warn"
            );
            ui.setStage("已终止");
          } else {
            ui.log("异常: " + (e && e.message ? e.message : e), "error");
            ui.setStage("失败");
          }
        })
        .then(function () {
          busy = false;
          currentRun = null;
          stopWrap.hidden = true;
          exportBtn.disabled = false;
          ui.setBusy(false);
        });
    }

    stopBtn.onclick = function () {
      if (!currentRun) return;
      abortRun(currentRun.token, "用户主动终止");
      stopBtn.disabled = true;
      stopBtn.textContent = "正在终止…";
      ui.log(
        "收到终止请求，将在下一个检查点停止（进行中的网络请求无法立即中断）...",
        "warn"
      );
    };

    exportBtn.onclick = runExport;
  }

  window.__ldExport = {
    htmlToMarkdown: htmlToMarkdown,
    convert: convert,
    fetchPostsInRange: fetchPostsInRange,
    formatTopicMarkdown: formatTopicMarkdown,
    getJSON: getJSON,
    exportSingleTopic: exportSingleTopic,
    detectLang: detectLang,
    newRunToken: newRunToken,
    abortRun: abortRun,
    checkAbort: checkAbort,
    safeName: safeName,
    downloadBlob: downloadBlob,
    RATE: RATE
  };

  var host = location.hostname || "";
  if (host === "linux.do" || host.slice(-9) === ".linux.do") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", injectUI);
    } else {
      injectUI();
    }
  }
})();
