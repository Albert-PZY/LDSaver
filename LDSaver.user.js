// ==UserScript==
// @name         LDSaver
// @namespace    https://linux.do/
// @version      1.5.3
// @description  linux.do 帖子导出 Markdown / PDF（MD→PDF）、可选原图 ZIP、代码高亮、温和限速
// @author       albert
// @icon         https://picui.ogmua.cn/s1/2026/07/24/6a624ed8b0986.webp
// @match        https://linux.do/*
// @require      https://cdn.jsdelivr.net/npm/html2pdf.js@0.10.2/dist/html2pdf.bundle.min.js
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @grant        GM_xmlhttpRequest
// @connect      linux.do
// @connect      cdn.jsdelivr.net
// @connect      cdn.ldstatic.com
// @connect      cdn2.ldstatic.com
// @connect      cdn3.ldstatic.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  var RATE = {
    apiGap: 1000,
    apiJitter: 400,
    batchSize: 8,
    batchGap: 1500,
    imgGap: 280,
    imgJitter: 120,
    imgConcurrency: 3,
    retries: 4,
    maxImages: 120,
    warnFloors: 80
  };
  var PDF_W = 700;
  var CDN = {
    h2p: "https://cdn.jsdelivr.net/npm/html2pdf.js@0.10.2/dist/html2pdf.bundle.min.js",
    zip: "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"
  };

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function jitter(base, j) {
    return base + Math.floor(Math.random() * (j + 1));
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return (
        {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;"
        }[c] || c
      );
    });
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

  /* ---------- 限速 ---------- */
  var lastApi = 0;
  var lastImg = 0;
  var apiQ = Promise.resolve();

  function throttle(kind) {
    var gap = kind === "img" ? RATE.imgGap : RATE.apiGap;
    var j = kind === "img" ? RATE.imgJitter : RATE.apiJitter;
    var last = kind === "img" ? lastImg : lastApi;
    var wait = jitter(gap, j) - (Date.now() - last);
    return (wait > 0 ? sleep(wait) : Promise.resolve()).then(function () {
      if (kind === "img") lastImg = Date.now();
      else lastApi = Date.now();
    });
  }

  function enqueueApi(fn) {
    var run = apiQ.then(function () {
      return throttle("api");
    }).then(fn, fn);
    apiQ = run.then(
      function () {},
      function () {}
    );
    return run;
  }

  /* ---------- 工具 ---------- */
  function downloadBlob(content, filename, mime) {
    var blob =
      content instanceof Blob
        ? content
        : new Blob([content], { type: mime || "text/plain;charset=utf-8" });
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

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var hit = document.querySelector('script[src="' + src + '"]');
      if (hit && hit.getAttribute("data-loaded") === "1") {
        resolve();
        return;
      }
      if (hit) {
        hit.addEventListener("load", function () {
          resolve();
        });
        hit.addEventListener("error", function () {
          reject(new Error("load fail: " + src));
        });
        return;
      }
      var s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = function () {
        s.setAttribute("data-loaded", "1");
        resolve();
      };
      s.onerror = function () {
        reject(new Error("load fail: " + src));
      };
      document.head.appendChild(s);
    });
  }

  function ensureHtml2Pdf() {
    if (typeof html2pdf === "function") return Promise.resolve(html2pdf);
    return loadScript(CDN.h2p).then(function () {
      if (typeof html2pdf !== "function") throw new Error("html2pdf 未就绪");
      return html2pdf;
    });
  }

  function ensureJSZip() {
    if (typeof JSZip !== "undefined") return Promise.resolve(JSZip);
    return loadScript(CDN.zip).then(function () {
      if (typeof JSZip === "undefined") throw new Error("JSZip 未就绪");
      return JSZip;
    });
  }

  function waitForImages(root, ms) {
    if (ms == null) ms = 10000;
    var imgs = Array.prototype.slice.call(root.querySelectorAll("img"));
    return Promise.all(
      imgs.map(function (img) {
        return new Promise(function (done) {
          if (img.complete && img.naturalWidth) {
            done();
            return;
          }
          var finished = false;
          function fin() {
            if (finished) return;
            finished = true;
            done();
          }
          img.addEventListener("load", fin);
          img.addEventListener("error", fin);
          if (typeof img.decode === "function") {
            img.decode().then(fin).catch(fin);
          }
          setTimeout(fin, ms);
        });
      })
    );
  }

  function guessExt(url, mime) {
    if (mime) {
      var mm = mime.match(/image\/([\w+.-]+)/i);
      if (mm) {
        var e = mm[1]
          .toLowerCase()
          .replace("jpeg", "jpg")
          .replace("svg+xml", "svg")
          .replace("+xml", "");
        if (/^(png|jpg|gif|webp|svg|bmp|avif)$/.test(e)) return "." + e;
      }
    }
    try {
      var m = new URL(url, location.origin).pathname.match(
        /\.(png|jpe?g|gif|webp|svg|bmp|avif)(?:$|\?)/i
      );
      if (m) return "." + m[1].toLowerCase().replace("jpeg", "jpg");
    } catch (_e) {}
    return ".png";
  }

  function uiCall(ui, method, a, b, c) {
    if (!ui || typeof ui[method] !== "function") return;
    if (arguments.length === 2) return ui[method]();
    if (arguments.length === 3) return ui[method](a);
    if (arguments.length === 4) return ui[method](a, b);
    return ui[method](a, b, c);
  }

  /* ---------- 网络 ---------- */
  function getJSON(url, retries) {
    if (retries == null) retries = RATE.retries;
    return enqueueApi(function () {
      var lastErr = null;
      var i = 0;
      function attempt() {
        return fetch(url, {
          headers: {
            Accept: "application/json",
            "X-Requested-With": "XMLHttpRequest"
          },
          credentials: "include"
        }).then(function (r) {
          if (r.status === 429) {
            return sleep(8000 * Math.pow(2, i) + Math.random() * 2000).then(
              function () {
                i++;
                if (i >= retries) throw new Error("429 重试耗尽: " + url);
                return attempt();
              }
            );
          }
          if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
          return r.json();
        }).catch(function (e) {
          lastErr = e;
          i++;
          if (i >= retries) throw lastErr || new Error("重试耗尽: " + url);
          return sleep(2000 * i).then(attempt);
        });
      }
      return attempt();
    });
  }

  function gmBinary(url) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(new Error("无 GM_xmlhttpRequest"));
        return;
      }
      GM_xmlhttpRequest({
        method: "GET",
        url: url,
        responseType: "arraybuffer",
        timeout: 45000,
        onload: function (res) {
          if (res.status < 200 || res.status >= 300) {
            reject(new Error("GM " + res.status));
            return;
          }
          var mime = "";
          var m = String(res.responseHeaders || "").match(
            /content-type:\s*([^\r\n;]+)/i
          );
          if (m) mime = m[1].trim();
          resolve({ buffer: res.response, mime: mime });
        },
        onerror: function () {
          reject(new Error("GM error"));
        },
        ontimeout: function () {
          reject(new Error("GM timeout"));
        }
      });
    });
  }

  function fetchBinary(url) {
    var full = absUrl(url);
    return throttle("img").then(function () {
      return fetch(full, {
        credentials: "omit",
        mode: "cors",
        cache: "force-cache"
      })
        .then(function (r) {
          if (!r.ok) throw new Error("fetch " + r.status);
          return r.arrayBuffer().then(function (buffer) {
            return {
              buffer: buffer,
              mime: r.headers.get("content-type") || ""
            };
          });
        })
        .catch(function () {
          return gmBinary(full).catch(function (e) {
            return throttle("img").then(function () {
              return fetch(full, { credentials: "include" }).then(function (r) {
                if (!r.ok) throw e;
                return r.arrayBuffer().then(function (buffer) {
                  return {
                    buffer: buffer,
                    mime: r.headers.get("content-type") || ""
                  };
                });
              });
            });
          });
        });
    });
  }

  function mapPool(items, concurrency, worker) {
    var ret = new Array(items.length);
    var next = 0;
    function runner() {
      if (next >= items.length) return Promise.resolve();
      var i = next++;
      return Promise.resolve(worker(items[i], i)).then(function (v) {
        ret[i] = v;
        return runner();
      });
    }
    var n = Math.min(concurrency, Math.max(items.length, 1));
    var runners = [];
    for (var k = 0; k < n; k++) runners.push(runner());
    return Promise.all(runners).then(function () {
      return ret;
    });
  }

  function isPrecompressedImage(name, mime) {
    var m = String(mime || "").toLowerCase();
    var n = String(name || "").toLowerCase();
    return (
      /image\/(jpeg|jpg|png|webp|gif|avif)/.test(m) ||
      /\.(jpe?g|png|webp|gif|avif)$/.test(n)
    );
  }

  function toDataUrl(url) {
    return fetchBinary(url).then(function (res) {
      var type =
        res.mime && res.mime.indexOf("image/") === 0
          ? res.mime.split(";")[0]
          : "image/png";
      var bytes = new Uint8Array(res.buffer);
      var bin = "";
      var chunk = 0x8000;
      for (var i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(
          null,
          bytes.subarray(i, i + chunk)
        );
      }
      return "data:" + type + ";base64," + btoa(bin);
    });
  }

  /* ---------- 代码语言 / 高亮 ---------- */
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

  function langFromClass(cls) {
    var m = String(cls || "").match(
      /(?:^|\s)(?:lang(?:uage)?-|highlight-)([a-z0-9+#.-]+)/i
    );
    return m ? normLang(m[1]) : "";
  }

  function detectLang(code, className) {
    var from = langFromClass(className);
    if (from) return from;
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
      /<<-?\s*['"]?\w+/.test(s) ||
      (/\$\([^)]+\)|`[^`]+`/.test(s) && /\$|echo|bash|\bsh\b/.test(s)) ||
      /^\s*\.\/\S+/m.test(lines) ||
      (/\$[0-9*@#?$!-]/.test(s) && !/function\s*\(|=>|const |let |var /.test(s))
    ) {
      return "bash";
    }
    return "";
  }

  var HL_KW = {
    bash: "if|then|else|elif|fi|for|while|do|done|case|esac|in|function|return|exit|echo|export|local|true|false|test",
    python:
      "and|as|assert|async|await|break|class|continue|def|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|not|or|pass|raise|return|True|try|while|with|yield",
    javascript:
      "async|await|break|case|catch|class|const|continue|default|else|export|extends|finally|for|function|if|import|in|instanceof|let|new|of|return|static|super|switch|this|throw|try|typeof|var|while|yield|true|false|null|undefined",
    go: "break|case|const|continue|default|defer|else|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var|true|false|nil",
    rust: "as|async|await|break|const|continue|else|enum|fn|for|if|impl|in|let|loop|match|mod|mut|pub|ref|return|self|Self|static|struct|trait|true|type|use|where|while",
    sql: "select|from|where|and|or|not|insert|into|values|update|set|delete|create|table|join|left|right|inner|on|group|by|order|limit|as|in|is|null|like|distinct|union|case|when|then|else|end"
  };
  HL_KW.typescript = HL_KW.javascript;
  HL_KW.shell = HL_KW.bash;

  function highlight(code, lang) {
    var html = esc(String(code || "").replace(/\n+$/, ""));
    function wrap(re, cls) {
      html = html.replace(re, function (m) {
        return '<span class="hl-' + cls + '">' + m + "</span>";
      });
    }
    if (/^(bash|python|yaml|ruby)$/.test(lang)) {
      wrap(/(^|\n)(\s*#(?!!).*?)(?=\n|$)/g, "cmt");
    }
    if (/^(javascript|typescript|java|c|cpp|go|rust|css|json)$/.test(lang)) {
      wrap(/(\/\/.*?)$/gm, "cmt");
      wrap(/(\/\*[\s\S]*?\*\/)/g, "cmt");
    }
    if (lang === "sql") wrap(/(--.*?)$/gm, "cmt");
    wrap(/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|`[^`]*?`)/g, "str");
    wrap(/\b(\d+(?:\.\d+)?)\b/g, "num");
    var kw = HL_KW[lang];
    if (kw) wrap(new RegExp("\\b(" + kw + ")\\b", "gi"), "kw");
    if (lang === "bash") {
      wrap(/(\$\{?[A-Za-z_]\w*\}?|\$\d+|\$[@*#?$!-])/g, "var");
    }
    return html;
  }

  /* ---------- HTML → Markdown ---------- */
  function createImageCollector(topicId) {
    var map = {};
    var order = [];
    var i = 0;
    return {
      topicId: String(topicId),
      size: function () {
        return order.length;
      },
      entries: function () {
        return order.slice();
      },
      register: function (url, nameHint) {
        if (
          !url ||
          isEmoji(url) ||
          url.indexOf("data:") === 0 ||
          order.length >= RATE.maxImages
        ) {
          return null;
        }
        var full = absUrl(url);
        if (map[full]) return map[full];
        i++;
        var base = nameHint
          ? safeName(nameHint).replace(/\.[a-z0-9]+$/i, "").slice(0, 40)
          : "";
        var name =
          (base ? base + "-" : "") +
          "img-" +
          ("000" + i).slice(-3) +
          guessExt(full);
        var entry = {
          url: full,
          name: name,
          localPath: topicId + "/" + name
        };
        map[full] = entry;
        order.push(entry);
        return entry;
      }
    };
  }

  function htmlToMarkdown(html, ctx) {
    if (!html) return "";
    if (!ctx) ctx = {};
    var doc = new DOMParser().parseFromString(
      '<div id="r">' + html + "</div>",
      "text/html"
    );
    return convert(doc.getElementById("r"), ctx)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function kids(node, ctx) {
    var out = "";
    var child = node.childNodes;
    for (var i = 0; i < child.length; i++) out += convert(child[i], ctx);
    return out;
  }

  function convert(node, ctx) {
    if (!node) return "";
    if (!ctx) ctx = {};
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    var tag = node.tagName.toLowerCase();
    function ch() {
      return kids(node, ctx);
    }
    function strip(s) {
      return s.replace(/\s+/g, " ").trim();
    }

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
      case "code":
        if (node.parentElement && node.parentElement.tagName === "PRE") {
          return ch();
        }
        var t = node.textContent || "";
        var q = t.indexOf("`") >= 0 ? "``" : "`";
        return q + t + q;
      case "pre": {
        var code = node.querySelector("code");
        var raw = ((code || node).textContent || "").replace(/\n+$/, "");
        var lang = detectLang(raw, ((code || node).className || ""));
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
          strip(ch()) +
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
        return convertImg(node, ctx);
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
        return "";
      default:
        if (node.classList && node.classList.contains("onebox")) {
          return convertOnebox(node);
        }
        if (node.classList && node.classList.contains("quote")) {
          return convertQuote(node, ctx);
        }
        return ch();
    }
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

  function list(node, ctx, ordered) {
    var start = parseInt(node.getAttribute("start") || "1", 10) || 1;
    var items = [];
    var children = node.children;
    for (var i = 0; i < children.length; i++) {
      if (children[i].tagName !== "LI") continue;
      var li = children[i];
      var nested = [];
      var liKids = li.children;
      for (var j = 0; j < liKids.length; j++) {
        if (liKids[j].tagName === "UL" || liKids[j].tagName === "OL") {
          nested.push(liKids[j]);
        }
      }
      var bodyParts = [];
      var nodes = li.childNodes;
      for (var k = 0; k < nodes.length; k++) {
        var n = nodes[k];
        if (
          n.nodeType === 1 &&
          (n.tagName === "UL" || n.tagName === "OL")
        ) {
          continue;
        }
        bodyParts.push(convert(n, ctx));
      }
      var body = bodyParts.join("").trim();
      var nest = "";
      for (var n2 = 0; n2 < nested.length; n2++) {
        nest +=
          "\n" +
          list(nested[n2], ctx, nested[n2].tagName === "OL").replace(
            /^/gm,
            "  "
          );
      }
      var marker = ordered ? start + items.length + "." : "-";
      items.push(marker + " " + body + nest);
    }
    return items.join("\n");
  }

  function convertA(node, ctx) {
    var href = node.getAttribute("href") || "";
    if (node.classList.contains("anchor")) return "";
    if (node.classList.contains("mention")) return node.textContent.trim();
    if (
      node.classList.contains("hashtag") ||
      node.classList.contains("hashtag-cooked")
    ) {
      var spans = node.querySelectorAll("span");
      var name = "";
      for (var i = 0; i < spans.length; i++) {
        var tx = spans[i].textContent.trim();
        if (tx) name = tx;
      }
      if (!name) name = node.textContent.trim();
      return "#" + name;
    }
    if (node.classList.contains("lightbox")) {
      var img = node.querySelector("img");
      var alt = (
        (img && img.getAttribute("alt")) ||
        node.getAttribute("title") ||
        "image"
      ).trim();
      var original = absUrl(href || "");
      var optimized = absUrl(
        (img && (img.getAttribute("src") || img.getAttribute("data-src"))) ||
          ""
      );
      var online = original || optimized;
      if (ctx.images && online && !isEmoji(online)) {
        var e = ctx.images.register(original || optimized, alt);
        if (e) return "![" + alt + "](" + e.localPath + ")";
      }
      return "![" + alt + "](" + online + ")";
    }
    var text = kids(node, ctx).trim() || href;
    if (!href || href.charAt(0) === "#") return text;
    return "[" + text + "](" + href + ")";
  }

  function convertImg(node, ctx) {
    if (node.classList.contains("emoji")) {
      return node.getAttribute("title") || node.getAttribute("alt") || "";
    }
    var parent = node.parentElement;
    if (
      parent &&
      parent.classList &&
      parent.classList.contains("lightbox") &&
      ctx.images
    ) {
      return "";
    }
    var parentHref =
      parent && parent.classList && parent.classList.contains("lightbox")
        ? parent.getAttribute("href")
        : "";
    var src =
      parentHref ||
      node.getAttribute("data-orig-src") ||
      node.getAttribute("src") ||
      node.getAttribute("data-src") ||
      "";
    var online = absUrl(src);
    if (!online || isEmoji(online)) {
      return (node.getAttribute("alt") || "").trim();
    }
    var alt = (node.getAttribute("alt") || "").trim() || "image";
    if (ctx.images) {
      var e = ctx.images.register(online, alt);
      if (e) return "![" + alt + "](" + e.localPath + ")";
    }
    return "![" + alt + "](" + online + ")";
  }

  function convertTable(node, ctx) {
    var trs = node.querySelectorAll("tr");
    var rows = [];
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
      rows.push(cells);
    }
    if (!rows.length) return "";
    var cols = 0;
    for (var r = 0; r < rows.length; r++) {
      if (rows[r].length > cols) cols = rows[r].length;
    }
    for (var r2 = 0; r2 < rows.length; r2++) {
      while (rows[r2].length < cols) rows[r2].push("");
    }
    var lines = [];
    lines.push("| " + rows[0].join(" | ") + " |");
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
      author = c.textContent.replace(/[:：\s]+$/g, "").trim();
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
  function fetchPostsInRange(topicId, from, to, onProgress) {
    return getJSON("/t/" + topicId + ".json").then(function (base) {
      var stream =
        (base.post_stream && base.post_stream.stream) || [];
      var initial =
        (base.post_stream && base.post_stream.posts) || [];
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
        if (start >= need.length) {
          return Promise.resolve();
        }
        var batch = need.slice(start, start + RATE.batchSize);
        var params = batch
          .map(function (id) {
            return "post_ids[]=" + id;
          })
          .join("&");
        return getJSON("/t/" + topicId + "/posts.json?" + params).then(
          function (j) {
            var posts =
              (j.post_stream && j.post_stream.posts) || [];
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

  /* ---------- Markdown / ZIP ---------- */
  function formatTopicMarkdown(topic, posts, opts, images) {
    var title = topic.title || topic.fancy_title || "无标题";
    var id = topic.id;
    var url =
      "https://linux.do/t/" + (topic.slug || "topic") + "/" + id;
    var tags = [];
    if (Array.isArray(topic.tags)) {
      for (var ti = 0; ti < topic.tags.length; ti++) {
        var tg = topic.tags[ti];
        tags.push(typeof tg === "string" ? tg : tg.name);
      }
      tags = tags.filter(Boolean);
    }
    var author0 =
      (posts[0] && (posts[0].display_username || posts[0].username)) ||
      "";
    var created = postTime(topic.created_at);
    var ctx = { images: images };
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
      var body = htmlToMarkdown(p.cooked || "", ctx);
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

  function exportSingleTopic(topicId, opts, ui) {
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
        uiCall(ui, "progress", 0.05 + (0.25 * d) / Math.max(t, 1));
      }
    ).then(function (data) {
      var topic = data.topic;
      var posts = data.posts;
      uiCall(ui, "setStage", "生成 Markdown");
      uiCall(ui, "progress", 0.32);

      var images = opts.downloadImages
        ? createImageCollector(topic.id)
        : null;
      var r = formatTopicMarkdown(topic, posts, opts, images);
      var entries = images ? images.entries() : [];

      if (!entries.length) {
        downloadBlob(r.md, r.filename, "text/markdown;charset=utf-8");
        uiCall(ui, "progress", 1);
        uiCall(ui, "setStage", "完成");
        var tip = opts.downloadImages ? "无图片" : "图片使用在线链接";
        uiCall(
          ui,
          "log",
          "✓ 已下载 " + r.filename + "（" + posts.length + " 楼，" + tip + "）",
          "ok"
        );
        return { type: "md", filename: r.filename };
      }

      uiCall(
        ui,
        "log",
        "发现 " +
          entries.length +
          " 张原图，并发下载中（" +
          RATE.imgConcurrency +
          " 路）..."
      );
      uiCall(ui, "setStage", "下载图片 0/" + entries.length);

      var ok = 0;
      var fail = 0;
      var done = 0;
      var pathMap = {};

      return mapPool(entries, RATE.imgConcurrency, function (e) {
        return fetchBinary(e.url)
          .then(function (res) {
            var name = e.name;
            var ext = guessExt(e.url, res.mime);
            if (ext && name.toLowerCase().slice(-ext.length) !== ext) {
              name = name.replace(/\.[a-z0-9]+$/i, "") + ext;
            }
            var path = topic.id + "/" + name;
            pathMap[e.localPath] = path;
            ok++;
            return {
              ok: true,
              path: path,
              buffer: res.buffer,
              name: name,
              mime: res.mime
            };
          })
          .catch(function (err) {
            fail++;
            return {
              ok: false,
              err: err && err.message ? err.message : String(err),
              url: e.url
            };
          })
          .then(function (result) {
            done++;
            uiCall(ui, "setStage", "下载图片 " + done + "/" + entries.length);
            uiCall(
              ui,
              "progress",
              0.32 + (0.48 * done) / entries.length
            );
            if (done === 1 || done === entries.length || done % 5 === 0) {
              uiCall(
                ui,
                "log",
                "图片进度 " +
                  done +
                  "/" +
                  entries.length +
                  "（成功 " +
                  ok +
                  " / 失败 " +
                  fail +
                  "）"
              );
            }
            return result;
          });
      }).then(function (results) {
        var md = r.md;
        Object.keys(pathMap).forEach(function (from) {
          var to = pathMap[from];
          if (to !== from) {
            md = md.split(from).join(to);
          }
        });

        uiCall(ui, "setStage", "打包 ZIP");
        uiCall(ui, "log", "正在打包（图片直存不二次压缩）...");
        uiCall(ui, "progress", 0.82);

        return ensureJSZip().then(function (Zip) {
          var zip = new Zip();
          zip.file(r.filename, md, {
            compression: "DEFLATE",
            compressionOptions: { level: 6 }
          });
          for (var fi = 0; fi < results.length; fi++) {
            var f = results[fi];
            if (!f || !f.ok) continue;
            var store = isPrecompressedImage(f.name, f.mime);
            zip.file(f.path, f.buffer, {
              compression: store ? "STORE" : "DEFLATE",
              compressionOptions: store ? undefined : { level: 1 }
            });
          }
          for (var fj = 0; fj < results.length; fj++) {
            var ff = results[fj];
            if (ff && !ff.ok) {
              uiCall(
                ui,
                "log",
                "图片失败: " +
                  String(ff.url || "").slice(0, 72) +
                  "... (" +
                  ff.err +
                  ")",
                "warn"
              );
            }
          }

          var lastPctLog = -1;
          return zip
            .generateAsync(
              { type: "blob", streamFiles: true },
              function (meta) {
                var p = meta.percent || 0;
                uiCall(ui, "progress", 0.82 + (0.17 * p) / 100);
                uiCall(ui, "setStage", "打包 ZIP " + p.toFixed(0) + "%");
                var bucket = Math.floor(p / 10);
                if (
                  bucket !== lastPctLog &&
                  (bucket % 2 === 0 || p >= 99)
                ) {
                  lastPctLog = bucket;
                  uiCall(ui, "log", "打包进度 " + p.toFixed(0) + "%");
                }
              }
            )
            .then(function (blob) {
              var zipName = safeName(r.title) + "-" + topic.id + ".zip";
              downloadBlob(blob, zipName, "application/zip");
              uiCall(ui, "progress", 1);
              uiCall(ui, "setStage", "完成");
              uiCall(
                ui,
                "log",
                "✓ 已下载 " +
                  zipName +
                  "（" +
                  posts.length +
                  " 楼，图 " +
                  ok +
                  " 成功 / " +
                  fail +
                  " 失败）",
                "ok"
              );
              return { type: "zip", filename: zipName, images: ok };
            });
        });
      });
    });
  }

  /* ---------- Markdown → HTML → PDF ---------- */
  function inlineMd(text) {
    var s = esc(text);
    var codes = [];
    s = s.replace(/`([^`]+)`/g, function (_m, c) {
      codes.push(c);
      return "\u0000C" + (codes.length - 1) + "\u0000";
    });
    s = s
      .replace(
        /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
        function (_m, alt, src) {
          return (
            '<img src="' + esc(src) + '" alt="' + esc(alt) + '" />'
          );
        }
      )
      .replace(
        /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
        function (_m, t, href) {
          return '<a href="' + esc(href) + '">' + t + "</a>";
        }
      )
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>")
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
      .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
    s = s.replace(/\u0000C(\d+)\u0000/g, function (_m, i) {
      return "<code>" + codes[+i] + "</code>";
    });
    return s;
  }

  function mdToHtml(md) {
    var src = String(md || "").replace(/\r\n/g, "\n");
    src = src.replace(/^---\n[\s\S]*?\n---\n*/, "");
    var blocks = [];
    src = src.replace(/```([^\n`]*)\n([\s\S]*?)```/g, function (_m, lang, code) {
      var L = String(lang || "").trim();
      var raw = code.replace(/\n$/, "");
      var id = blocks.length;
      blocks.push(
        '<div class="ld-code">' +
          (L ? '<div class="ld-code-lang">' + esc(L) + "</div>" : "") +
          "<code>" +
          highlight(raw, L || "bash") +
          "</code></div>"
      );
      return "\n\n%%BLK" + id + "%%\n\n";
    });

    var lines = src.split("\n");
    var out = [];
    var i = 0;

    function flushPara(buf) {
      var t = buf.join(" ").trim();
      if (t) out.push("<p>" + inlineMd(t) + "</p>");
      buf.length = 0;
    }

    while (i < lines.length) {
      var line = lines[i];
      var t = line.trim();
      var bm = t.match(/^%%BLK(\d+)%%$/);
      if (bm) {
        out.push(blocks[+bm[1]]);
        i++;
        continue;
      }
      if (!t) {
        i++;
        continue;
      }

      var hm = t.match(/^(#{1,6})\s+(.+)$/);
      if (hm) {
        var lv = hm[1].length;
        out.push("<h" + lv + ">" + inlineMd(hm[2]) + "</h" + lv + ">");
        i++;
        continue;
      }

      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
        out.push("<hr/>");
        i++;
        continue;
      }

      if (/^>\s?/.test(t)) {
        var qs = [];
        while (i < lines.length && /^>\s?/.test(lines[i] || "")) {
          qs.push(lines[i].replace(/^>\s?/, ""));
          i++;
        }
        var inner = qs
          .map(function (q) {
            return q.trim() === "" ? "<br/>" : inlineMd(q);
          })
          .join("<br/>");
        out.push("<blockquote>" + inner + "</blockquote>");
        continue;
      }

      if (
        t.indexOf("|") >= 0 &&
        i + 1 < lines.length &&
        /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(lines[i + 1].trim())
      ) {
        function splitRow(row) {
          return row
            .replace(/^\||\|$/g, "")
            .split("|")
            .map(function (c) {
              return c.trim();
            });
        }
        var head = splitRow(t);
        i += 2;
        var bodyRows = [];
        while (
          i < lines.length &&
          lines[i].indexOf("|") >= 0 &&
          lines[i].trim()
        ) {
          bodyRows.push(splitRow(lines[i]));
          i++;
        }
        var table =
          "<table><thead><tr>" +
          head
            .map(function (c) {
              return "<th>" + inlineMd(c) + "</th>";
            })
            .join("") +
          "</tr></thead><tbody>";
        for (var br = 0; br < bodyRows.length; br++) {
          table +=
            "<tr>" +
            bodyRows[br]
              .map(function (c) {
                return "<td>" + inlineMd(c) + "</td>";
              })
              .join("") +
            "</tr>";
        }
        table += "</tbody></table>";
        out.push(table);
        continue;
      }

      if (/^[-*+]\s+/.test(t) || /^\d+\.\s+/.test(t)) {
        var ordered = /^\d+\.\s+/.test(t);
        var tag = ordered ? "ol" : "ul";
        var re = ordered ? /^\d+\.\s+(.*)$/ : /^[-*+]\s+(.*)$/;
        var items = [];
        while (i < lines.length) {
          var m = lines[i].trim().match(re);
          if (!m) break;
          items.push("<li>" + inlineMd(m[1]) + "</li>");
          i++;
        }
        out.push("<" + tag + ">" + items.join("") + "</" + tag + ">");
        continue;
      }

      var buf = [];
      while (i < lines.length) {
        var L = lines[i];
        var tt = L.trim();
        if (
          !tt ||
          /^%%BLK\d+%%$/.test(tt) ||
          /^(#{1,6})\s+/.test(tt) ||
          /^>\s?/.test(tt) ||
          /^(-{3,}|\*{3,})$/.test(tt) ||
          /^[-*+]\s+/.test(tt) ||
          /^\d+\.\s+/.test(tt) ||
          (tt.indexOf("|") >= 0 &&
            i + 1 < lines.length &&
            /^\|?\s*:?-+:?/.test((lines[i + 1] || "").trim()))
        ) {
          break;
        }
        buf.push(tt);
        i++;
      }
      flushPara(buf);
    }
    return out.join("\n");
  }

  var PDF_CSS = (
    ".ld-pdf{box-sizing:border-box;width:" +
    PDF_W +
    "px;max-width:" +
    PDF_W +
    "px;margin:0 auto;padding:12px 8px 28px;color:#1f2328;background:#fff;" +
    "font:13.5px/1.75 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;word-wrap:break-word;overflow-wrap:anywhere}" +
    ".ld-pdf *{box-sizing:border-box;max-width:100%}" +
    ".ld-pdf h1,.ld-pdf h2,.ld-pdf h3,.ld-pdf h4{line-height:1.35;margin:1.1em 0 .5em;color:#111;page-break-after:avoid}" +
    ".ld-pdf h1{font-size:22px;margin-top:0;border-bottom:1px solid #eaeef2;padding-bottom:10px}" +
    ".ld-pdf h2{font-size:17px}.ld-pdf h3{font-size:15px}.ld-pdf h4{font-size:14px}" +
    ".ld-pdf p{margin:.55em 0}.ld-pdf a{color:#0969da;text-decoration:none;word-break:break-all}" +
    ".ld-pdf .ld-code{display:block;background:#0d1117;color:#e6edf3;padding:12px 14px;border-radius:8px;font-size:11.5px;line-height:1.55;" +
    "white-space:pre-wrap;word-break:break-word;margin:12px 0;border:1px solid #30363d}" +
    ".ld-pdf .ld-code code{background:transparent;color:inherit;padding:0;font-family:Consolas,'SF Mono',monospace;white-space:inherit}" +
    ".ld-pdf .ld-code-lang{display:block;font-size:10px;color:#8b949e;margin-bottom:6px;text-transform:uppercase;letter-spacing:.3px}" +
    ".ld-pdf .hl-kw{color:#ff7b72;font-weight:600}.ld-pdf .hl-str{color:#a5d6ff}.ld-pdf .hl-cmt{color:#8b949e;font-style:italic}" +
    ".ld-pdf .hl-num{color:#79c0ff}.ld-pdf .hl-var{color:#ffa657}" +
    ".ld-pdf p code,.ld-pdf li code,.ld-pdf td code{background:#f0f2f5;padding:1px 5px;border-radius:4px;font:90% Consolas,monospace;color:#cf222e}" +
    ".ld-pdf blockquote{border-left:4px solid #d0d7de;color:#57606a;margin:.9em 0;padding:.4em 0 .4em 12px;background:#f6f8fa}" +
    ".ld-pdf table{border-collapse:collapse;width:100%;margin:.9em 0;font-size:12.5px}" +
    ".ld-pdf th,.ld-pdf td{border:1px solid #d0d7de;padding:6px 8px;vertical-align:top;text-align:left}.ld-pdf th{background:#f6f8fa}" +
    ".ld-pdf img{display:block;max-width:100%;height:auto;margin:12px auto;page-break-inside:avoid}" +
    ".ld-pdf ul,.ld-pdf ol{padding-left:1.4em;margin:.5em 0}.ld-pdf li{margin:.2em 0}" +
    ".ld-pdf hr{border:0;border-top:1px dashed #d0d7de;margin:22px 0}" +
    ".ld-pdf del{color:#57606a}"
  );

  function inlineImages(root, ui) {
    var imgs = Array.prototype.slice.call(root.querySelectorAll("img"));
    var chain = Promise.resolve();
    imgs.forEach(function (img, idx) {
      chain = chain.then(function () {
        var src = absUrl(img.getAttribute("src") || "");
        if (!src || src.indexOf("data:") === 0 || isEmoji(src)) return;
        if (idx === 0) uiCall(ui, "log", "内联图片到 PDF...");
        return toDataUrl(src)
          .then(function (dataUrl) {
            img.setAttribute("src", dataUrl);
          })
          .catch(function () {})
          .then(function () {
            img.removeAttribute("width");
            img.removeAttribute("height");
          });
      });
    });
    return chain;
  }

  function markdownToPdf(md, filename, ui) {
    return ensureHtml2Pdf().then(function (h2p) {
      uiCall(ui, "setStage", "Markdown → HTML");
      uiCall(ui, "log", "Markdown → HTML...");
      var body = mdToHtml(md);
      uiCall(ui, "progress", 0.6);

      var iframe = document.createElement("iframe");
      iframe.setAttribute("aria-hidden", "true");
      iframe.style.cssText =
        "position:fixed;left:0;top:0;width:" +
        (PDF_W + 40) +
        "px;height:800px;opacity:0;pointer-events:none;border:0;z-index:-1";
      document.body.appendChild(iframe);
      var idoc = iframe.contentDocument;
      idoc.open();
      idoc.write(
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><style>" +
          PDF_CSS +
          "</style></head><body style=\"margin:0;background:#fff\"><div class=\"ld-pdf\" id=\"root\">" +
          body +
          "</div></body></html>"
      );
      idoc.close();
      var root = idoc.getElementById("root");

      return inlineImages(root, ui)
        .then(function () {
          uiCall(ui, "setStage", "处理图片");
          uiCall(ui, "progress", 0.72);
          uiCall(ui, "log", "等待资源就绪...");
          return waitForImages(root, 10000);
        })
        .then(function () {
          return sleep(100);
        })
        .then(function () {
          iframe.style.height =
            Math.max(root.scrollHeight, root.offsetHeight) + 40 + "px";
          return sleep(60);
        })
        .then(function () {
          uiCall(ui, "setStage", "渲染 PDF");
          uiCall(ui, "log", "正在渲染 PDF...");
          uiCall(ui, "progress", 0.8);
          return h2p()
            .set({
              margin: [12, 12, 14, 12],
              filename: filename,
              image: { type: "jpeg", quality: 0.9 },
              html2canvas: {
                scale: 1.5,
                useCORS: true,
                allowTaint: false,
                logging: false,
                backgroundColor: "#ffffff",
                imageTimeout: 20000,
                removeContainer: true,
                scrollX: 0,
                scrollY: 0,
                windowWidth: PDF_W + 40,
                width: PDF_W + 16
              },
              jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
              pagebreak: {
                mode: ["css", "legacy"],
                avoid: ["img", "h1", "h2", "h3", "table", ".ld-code-lang"]
              },
              enableLinks: false
            })
            .from(root)
            .outputPdf("blob");
        })
        .then(function (blob) {
          if (!(blob instanceof Blob) || blob.size < 100) {
            throw new Error("PDF 生成结果无效");
          }
          var pdf =
            blob.type === "application/pdf"
              ? blob
              : new Blob([blob], { type: "application/pdf" });
          downloadBlob(pdf, filename, "application/pdf");
          uiCall(ui, "progress", 1);
          uiCall(ui, "setStage", "完成");
          uiCall(
            ui,
            "log",
            "✓ 已下载 " +
              filename +
              "（" +
              (pdf.size / 1024).toFixed(1) +
              " KB）",
            "ok"
          );
          return { filename: filename, size: pdf.size };
        })
        .then(
          function (v) {
            iframe.remove();
            return v;
          },
          function (err) {
            iframe.remove();
            throw err;
          }
        );
    });
  }

  function exportCurrentTopicForPDF(topicId, opts, ui) {
    uiCall(ui, "log", "导出帖子 " + topicId + " 为 PDF...");
    uiCall(ui, "setStage", "拉取帖子");
    var range = (opts.toFloor || 1) - (opts.fromFloor || 1) + 1;
    if (range >= RATE.warnFloors) {
      uiCall(ui, "log", "楼层范围约 " + range + "，温和拉取中...", "warn");
    }
    return fetchPostsInRange(
      topicId,
      opts.fromFloor,
      opts.toFloor,
      function (d, t) {
        uiCall(ui, "progress", 0.05 + (0.35 * d) / Math.max(t, 1));
      }
    ).then(function (data) {
      var topic = data.topic;
      var posts = data.posts;
      uiCall(
        ui,
        "log",
        "✓ 已收集 " + posts.length + " 楼，生成 Markdown..."
      );
      uiCall(ui, "setStage", "生成 Markdown");
      uiCall(ui, "progress", 0.45);
      var pdfOpts = {};
      for (var k in opts) {
        if (Object.prototype.hasOwnProperty.call(opts, k)) pdfOpts[k] = opts[k];
      }
      pdfOpts.includeFrontmatter = false;
      var r = formatTopicMarkdown(topic, posts, pdfOpts, null);
      var filename = safeName(r.title) + "-" + topic.id + ".pdf";
      uiCall(ui, "progress", 0.55);
      uiCall(ui, "setStage", "Markdown → PDF");
      return markdownToPdf(r.md, filename, ui).then(function (out) {
        uiCall(ui, "progress", 1);
        uiCall(ui, "setStage", "完成");
        return out;
      });
    });
  }

  /* ---------- UI ---------- */
  var dock = { side: "right", y: null, open: false };

  function injectUI() {
    if (document.getElementById("ld-panel")) return;

    var style = document.createElement("style");
    style.textContent =
      "#ld-panel,#ld-handle{color-scheme:light dark;font:13px/1.4 system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;" +
      "-webkit-font-smoothing:antialiased;--fg:rgba(0,0,0,.9);--sub:rgba(0,0,0,.6);--dim:rgba(0,0,0,.45);" +
      "--in:rgba(255,255,255,.7);--inf:rgba(255,255,255,.98);--q:rgba(0,0,0,.05);--qh:rgba(0,0,0,.09);" +
      "--log:rgba(0,0,0,.05);--pdf:rgba(0,0,0,.07);--pdfh:rgba(0,0,0,.11);--tr:rgba(0,0,0,.08)}" +
      "@media(prefers-color-scheme:dark){#ld-panel,#ld-handle{--fg:rgba(255,255,255,.9);--sub:rgba(255,255,255,.6);--dim:rgba(255,255,255,.45);" +
      "--in:rgba(255,255,255,.1);--inf:rgba(255,255,255,.16);--q:rgba(255,255,255,.1);--qh:rgba(255,255,255,.15);" +
      "--log:rgba(0,0,0,.35);--pdf:rgba(255,255,255,.12);--pdfh:rgba(255,255,255,.18);--tr:rgba(255,255,255,.1)}}" +
      "#ld-handle{position:fixed;z-index:2147483646;width:20px;height:128px;background:light-dark(rgba(255,255,255,.8),rgba(0,0,0,.6));" +
      "-webkit-backdrop-filter:saturate(1.8) blur(20px);backdrop-filter:saturate(1.8) blur(20px);border-radius:12px;cursor:grab;" +
      "display:flex;align-items:center;justify-content:center;user-select:none;touch-action:none;" +
      "transition:width .25s cubic-bezier(.4,0,.2,1),opacity .2s,transform .35s}" +
      "#ld-handle:hover{width:26px}#ld-handle:active{cursor:grabbing}" +
      "#ld-handle::before{content:'';width:3px;height:32px;border-radius:2px;background:light-dark(rgba(0,0,0,.35),rgba(255,255,255,.55))}" +
      "#ld-handle.ld-left{left:0;border-radius:0 12px 12px 0}#ld-handle.ld-right{right:0;border-radius:12px 0 0 12px}#ld-handle.ld-hidden{display:none}" +
      "#ld-panel{position:fixed;z-index:2147483647;width:340px;max-height:88vh;background:light-dark(rgba(255,255,255,.8),rgba(0,0,0,.6));" +
      "-webkit-backdrop-filter:saturate(1.8) blur(20px);backdrop-filter:saturate(1.8) blur(20px);color:var(--fg);border-radius:28px;" +
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
      ".ld-body::-webkit-scrollbar{width:7px}.ld-body::-webkit-scrollbar-track{background:transparent;margin:6px 0}" +
      ".ld-body::-webkit-scrollbar-thumb{background:linear-gradient(180deg,rgba(0,113,227,.25),rgba(0,113,227,.45));border-radius:8px;border:2px solid transparent;background-clip:padding-box}" +
      ".ld-body::-webkit-scrollbar-thumb:hover{background:linear-gradient(180deg,rgba(0,113,227,.4),rgba(0,113,227,.65));background-clip:padding-box}" +
      ".ld-row{margin-bottom:16px}.ld-row>label{display:block;font-weight:600;margin-bottom:7px;font-size:12px;color:var(--fg)}" +
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
      ".ld-btn{flex:1;padding:11px 14px;border:0;border-radius:14px;cursor:pointer;font-size:13px;font-weight:600;transition:transform .12s,opacity .15s,background .18s}" +
      ".ld-btn-md{background:#0071e3;color:#fff}.ld-btn-md:hover{background:#0077ed}" +
      ".ld-btn-pdf{background:var(--pdf);color:var(--fg)}.ld-btn-pdf:hover{background:var(--pdfh)}" +
      ".ld-btn:active{transform:scale(.97)}.ld-btn:disabled{opacity:.5;cursor:not-allowed;transform:none!important}" +
      ".ld-progress-wrap{margin-top:14px}" +
      ".ld-progress-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px;min-height:16px}" +
      ".ld-progress-stage{font-size:11px;font-weight:500;color:var(--sub);letter-spacing:.2px;display:flex;align-items:center;gap:6px}" +
      ".ld-progress-stage .ld-spin{width:10px;height:10px;border:1.5px solid rgba(0,113,227,.25);border-top-color:#0071e3;border-radius:50%;display:none;animation:ld-spin .7s linear infinite}" +
      ".ld-progress-wrap.ld-busy .ld-spin{display:inline-block}" +
      ".ld-progress-pct{font-size:11px;font-weight:600;color:#0071e3;font-variant-numeric:tabular-nums;min-width:36px;text-align:right}" +
      ".ld-progress{height:6px;background:var(--tr);border-radius:99px;overflow:hidden;position:relative}" +
      ".ld-progress-bar{height:100%;width:0%;border-radius:99px;position:relative;" +
      "background:linear-gradient(90deg,#0071e3,#34a4ff 55%,#0071e3);background-size:200% 100%;" +
      "transition:width .28s cubic-bezier(.4,0,.2,1);box-shadow:0 0 10px rgba(0,113,227,.25)}" +
      ".ld-progress-wrap.ld-busy .ld-progress-bar{animation:ld-shimmer 1.4s linear infinite}" +
      ".ld-progress-wrap.ld-busy .ld-progress::after{content:'';position:absolute;inset:0;border-radius:99px;" +
      "background:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent);width:40%;" +
      "animation:ld-sweep 1.6s ease-in-out infinite;pointer-events:none}" +
      "@keyframes ld-shimmer{0%{background-position:100% 0}100%{background-position:-100% 0}}" +
      "@keyframes ld-sweep{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}" +
      "@keyframes ld-spin{to{transform:rotate(360deg)}}" +
      ".ld-log{margin-top:12px;padding:10px 12px;border-radius:12px;background:var(--log);color:var(--fg);" +
      "font:11.5px/1.65 'SF Mono',ui-monospace,Consolas,monospace;max-height:160px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;" +
      "scrollbar-width:thin;scrollbar-color:rgba(0,113,227,.35) transparent}" +
      ".ld-log::-webkit-scrollbar{width:6px}.ld-log::-webkit-scrollbar-track{background:transparent;margin:4px 0}" +
      ".ld-log::-webkit-scrollbar-thumb{background:linear-gradient(180deg,rgba(0,113,227,.25),rgba(0,113,227,.5));border-radius:8px}" +
      ".ld-log::-webkit-scrollbar-thumb:hover{background:rgba(0,113,227,.6)}" +
      ".ld-log .err{color:#ff6961}.ld-log .warn{color:#ffd60a}.ld-log .ok{color:#30d158}";
    document.head.appendChild(style);

    var handle = document.createElement("div");
    handle.id = "ld-handle";
    handle.title = "拖动改变位置，点击展开";
    var panel = document.createElement("div");
    panel.id = "ld-panel";
    panel.innerHTML =
      '<div class="ld-head" id="ld-head">' +
      '<div class="ld-drag-dots"><span><i></i><i></i><i></i></span><span><i></i><i></i><i></i></span></div>' +
      '<div class="ld-head-title"><b>导出工具</b><small>LINUX DO · 温和限速</small></div>' +
      '<button class="ld-close" id="ld-close" title="收起">×</button></div>' +
      '<div class="ld-body">' +
      '<div class="ld-row"><label>当前帖子</label>' +
      '<div class="ld-topic-info" id="ld-topic-info">' +
      '<div class="ld-topic-title" id="ld-topic-title">检测中...</div>' +
      '<div class="ld-topic-meta" id="ld-topic-meta"></div></div></div>' +
      '<div class="ld-row"><label>楼层范围</label>' +
      '<div class="ld-floor">' +
      '<input type="number" id="ld-from" value="1" min="1"><span>楼 至</span>' +
      '<input type="number" id="ld-to" value="1" min="1"><span>楼</span></div>' +
      '<div class="hint">可选将图片下载为原图并打 ZIP；不勾选则 MD 使用在线链接</div>' +
      '<div class="ld-chips">' +
      '<span class="ld-chip active" data-from="1" data-to="1">仅主楼</span>' +
      '<span class="ld-chip" data-from="1" data-to="5">前5楼</span>' +
      '<span class="ld-chip" data-from="1" data-to="10">前10楼</span>' +
      '<span class="ld-chip" data-from="1" data-to="50">前50楼</span>' +
      '<span class="ld-chip" data-from="1" data-to="99999">全部</span></div></div>' +
      '<div class="ld-row ld-check"><label for="ld-frontmatter">YAML frontmatter</label><input type="checkbox" id="ld-frontmatter" checked></div>' +
      '<div class="ld-row ld-check"><label for="ld-meta">帖子元信息</label><input type="checkbox" id="ld-meta" checked></div>' +
      '<div class="ld-row ld-check"><label for="ld-floorhdr">每楼楼层头</label><input type="checkbox" id="ld-floorhdr" checked></div>' +
      '<div class="ld-row ld-check"><label for="ld-dl-img">下载图片到本地（原图 · ZIP）</label><input type="checkbox" id="ld-dl-img"></div>' +
      '<div class="ld-btns">' +
      '<button class="ld-btn ld-btn-md" id="ld-export-md">导出 Markdown</button>' +
      '<button class="ld-btn ld-btn-pdf" id="ld-export-pdf">导出 PDF</button></div>' +
      '<div class="ld-progress-wrap" id="ld-progress-wrap">' +
      '<div class="ld-progress-meta">' +
      '<div class="ld-progress-stage"><span class="ld-spin"></span><span id="ld-progress-stage">就绪</span></div>' +
      '<div class="ld-progress-pct" id="ld-progress-pct">0%</div></div>' +
      '<div class="ld-progress"><div class="ld-progress-bar" id="ld-progress-bar"></div></div></div>' +
      '<div class="ld-log" id="ld-log"></div></div>';
    document.body.appendChild(handle);
    document.body.appendChild(panel);

    function clampY(y) {
      return Math.max(10, Math.min(y, window.innerHeight - 140));
    }

    function applyDock() {
      var y = clampY(dock.y != null ? dock.y : window.innerHeight * 0.3);
      handle.style.left = "";
      handle.style.right = "";
      handle.style.top = y + "px";
      if (dock.side === "left") {
        handle.classList.add("ld-left");
        handle.classList.remove("ld-right");
      } else {
        handle.classList.add("ld-right");
        handle.classList.remove("ld-left");
      }
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

    function drag(el, trigger, opts) {
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
        var nx = Math.max(0, Math.min(ox + dx, window.innerWidth - el.offsetWidth));
        var ny = clampY(oy + dy);
        el.style.left = nx + "px";
        el.style.top = ny + "px";
        el.style.right = "auto";
        dock.y = ny;
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

    drag(panel, document.getElementById("ld-head"), {
      onClick: function () {},
      onDock: applyDock
    });
    drag(handle, handle, { onClick: open, onDock: applyDock });
    document.getElementById("ld-close").onclick = close;
    window.addEventListener("resize", applyDock);

    var chips = panel.querySelectorAll(".ld-chip");
    for (var ci = 0; ci < chips.length; ci++) {
      (function (chip) {
        chip.onclick = function () {
          document.getElementById("ld-from").value = chip.getAttribute("data-from");
          document.getElementById("ld-to").value = chip.getAttribute("data-to");
          for (var j = 0; j < chips.length; j++) {
            if (chips[j] === chip) chips[j].classList.add("active");
            else chips[j].classList.remove("active");
          }
        };
      })(chips[ci]);
    }

    var logEl = document.getElementById("ld-log");
    var barEl = document.getElementById("ld-progress-bar");
    var wrapEl = document.getElementById("ld-progress-wrap");
    var stageEl = document.getElementById("ld-progress-stage");
    var pctEl = document.getElementById("ld-progress-pct");

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
        if (on) wrapEl.classList.add("ld-busy");
        else {
          wrapEl.classList.remove("ld-busy");
          stageEl.textContent = "就绪";
        }
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
        includeFloorHeader: document.getElementById("ld-floorhdr").checked,
        downloadImages: document.getElementById("ld-dl-img").checked
      };
    }

    var busy = false;
    function runExport(kind) {
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
      ui.setStage(kind === "md" ? "准备导出 Markdown" : "准备导出 PDF");
      var opts = readOpts();
      var btns = [
        document.getElementById("ld-export-md"),
        document.getElementById("ld-export-pdf")
      ];
      busy = true;
      btns[0].disabled = true;
      btns[1].disabled = true;

      var job =
        kind === "md"
          ? exportSingleTopic(t.topicId, opts, ui)
          : exportCurrentTopicForPDF(t.topicId, opts, ui);

      Promise.resolve(job)
        .catch(function (e) {
          ui.log("异常: " + (e && e.message ? e.message : e), "error");
          ui.setStage("失败");
        })
        .then(function () {
          busy = false;
          btns[0].disabled = false;
          btns[1].disabled = false;
          ui.setBusy(false);
        });
    }

    document.getElementById("ld-export-md").onclick = function () {
      runExport("md");
    };
    document.getElementById("ld-export-pdf").onclick = function () {
      runExport("pdf");
    };
  }

  window.__ldExport = {
    htmlToMarkdown: htmlToMarkdown,
    convert: convert,
    fetchPostsInRange: fetchPostsInRange,
    formatTopicMarkdown: formatTopicMarkdown,
    getJSON: getJSON,
    exportSingleTopic: exportSingleTopic,
    exportCurrentTopicForPDF: exportCurrentTopicForPDF,
    markdownToPdf: markdownToPdf,
    mdToHtml: mdToHtml,
    inlineMd: inlineMd,
    detectLang: detectLang,
    highlight: highlight,
    createImageCollector: createImageCollector,
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
