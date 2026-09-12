/**
 * MarkdownLite — 极小的、默认安全的 Markdown 渲染器。
 *
 * 为什么自己写：PROJECT_SPEC §17 / AGENTS.md §17 要求 Markdown 预览必须过滤
 * `<script>`、事件处理器、`javascript:`、`iframe`、SVG script，而引入
 * marked + DOMPurify 会显著增加产物与维护成本（AGENTS.md §29 要求优先原生方案）。
 * 因此这里采用「先整体转义、再做白名单替换」的架构：
 *
 *   1. 先把整段文本的 & < > " ' 全部转义 —— 因此**任何**原始 HTML 都不可能出现
 *      在输出里，包括 `<script>`、`<iframe>`、`<svg onload=...>`；
 *   2. 再只针对自己生成的、内容已被转义的片段拼接标签；
 *   3. 链接只允许 http/https/mailto/相对路径，`javascript:` 等协议一律降级为纯文本。
 *
 * 代价是不支持块级原始 HTML —— 这正是我们想要的取舍（宁可少渲染，不可 XSS）。
 * 唯一需要额外小心的是链接的协议白名单：即使内容已转义，`[x](javascript:...)`
 * 仍会在 href 里产生可执行 URL，所以 sanitizeUrl() 是安全性的关键。
 *
 * 暴露为浏览器全局 `MarkdownLite`（纯脚本，无打包器），并导出 render() 供 Node 测试。
 */
(function registerMarkdownLite(global) {
  'use strict';

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
  }

  /** 相对链接里出现的空白与控制字符可能用于构造 javascript: 绕过，先剥掉。 */
  function stripControlChars(value) {
    // eslint-disable-next-line no-control-regex
    return String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  }

  /**
   * 只放行绝对安全的 URL。返回 null 表示「不要生成链接」。
   *
   * 注意：这里必须在转义之后、去除控制字符之后的字符串上判断协议。
   */
  function sanitizeUrl(raw) {
    const value = stripControlChars(raw);
    if (!value) return null;
    // 相对路径、锚点、协议相对路径都可以。
    if (/^(#|\/(?!\/)|\.\/|\.\.\/)/.test(value)) return value;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
      const scheme = value.slice(0, value.indexOf(':')).toLowerCase();
      if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return value;
      return null;
    }
    // 没有协议的裸路径（例如 docs/a.md）也允许。
    return value;
  }

  function renderInline(text) {
    let out = escapeHtml(text);
    // 行内代码优先，避免其内部的 * _ 被当成强调解析。
    const codes = [];
    out = out.replace(/`([^`]+)`/g, (_m, code) => {
      codes.push(code);
      return `\u0000CODE${codes.length - 1}\u0000`;
    });
    // 图片必须在链接之前解析，否则 ![alt](src) 会被链接规则吃掉。
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_m, alt, src, title) => {
      const url = sanitizeUrl(src);
      if (!url) return escapeHtml(alt);
      const safeUrl = escapeHtml(url);
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return `<img src="${safeUrl}" alt="${alt}"${titleAttr} loading="lazy">`;
    });
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_m, label, href, title) => {
      const url = sanitizeUrl(href);
      if (!url) return label;
      const safeUrl = escapeHtml(url);
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      const external = /^https?:/i.test(url) ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${safeUrl}"${titleAttr}${external}>${label}</a>`;
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
    out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    out = out.replace(/\u0000CODE(\d+)\u0000/g, (_m, index) => `<code>${codes[Number(index)]}</code>`);
    return out;
  }

  function openList(stack, type, out) {
    if (stack[stack.length - 1] === type) return;
    if (stack.length) out.push(`</${stack.pop()}>`);
    out.push(type === 'ul' ? '<ul>' : '<ol>');
    stack.push(type);
  }

  function closeLists(stack, out) {
    while (stack.length) out.push(`</${stack.pop()}>`);
  }

  function render(source) {
    const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    const listStack = [];
    let inFence = false;
    let fenceLang = '';
    let fenceLines = [];
    let paragraph = [];

    const flushParagraph = () => {
      if (!paragraph.length) return;
      out.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
      paragraph = [];
    };

    for (const line of lines) {
      const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
      if (fence) {
        if (inFence) {
          const lang = fenceLang ? ` class="language-${escapeHtml(fenceLang)}"` : '';
          out.push(`<pre><code${lang}>${escapeHtml(fenceLines.join('\n'))}</code></pre>`);
          inFence = false;
          fenceLang = '';
          fenceLines = [];
        } else {
          flushParagraph();
          closeLists(listStack, out);
          inFence = true;
          fenceLang = fence[2] || '';
        }
        continue;
      }
      if (inFence) {
        fenceLines.push(line);
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        closeLists(listStack, out);
        continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flushParagraph();
        closeLists(listStack, out);
        const level = heading[1].length;
        out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
        continue;
      }

      if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
        flushParagraph();
        closeLists(listStack, out);
        out.push('<hr>');
        continue;
      }

      const quote = /^\s*>\s?(.*)$/.exec(line);
      if (quote) {
        flushParagraph();
        closeLists(listStack, out);
        out.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
        continue;
      }

      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (bullet) {
        flushParagraph();
        openList(listStack, 'ul', out);
        out.push(`<li>${renderInline(bullet[1])}</li>`);
        continue;
      }

      const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ordered) {
        flushParagraph();
        openList(listStack, 'ol', out);
        out.push(`<li>${renderInline(ordered[1])}</li>`);
        continue;
      }

      paragraph.push(line.trim());
    }

    if (inFence) {
      out.push(`<pre><code>${escapeHtml(fenceLines.join('\n'))}</code></pre>`);
    }
    flushParagraph();
    closeLists(listStack, out);
    return out.join('\n');
  }

  const api = { render, renderInline, escapeHtml, sanitizeUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MarkdownLite = api;
})(typeof window !== 'undefined' ? window : globalThis);
