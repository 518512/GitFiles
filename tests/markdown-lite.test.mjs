/**
 * MarkdownLite 测试。
 *
 * 重点是**安全**：PROJECT_SPEC §17 / AGENTS.md §17 要求 Markdown 预览必须
 * 防住 script、事件处理器、`javascript:`、iframe、svg script。这里逐条断言
 * 渲染结果里不出现可执行内容。
 *
 * 运行：node --test tests/markdown-lite.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = readFileSync(path.join(root, 'js/markdown-lite.js'), 'utf8');
// 与浏览器一致地以纯脚本方式加载到隔离的全局对象上
const sandbox = {};
new Function('module', 'window', 'globalThis', code).call(sandbox, undefined, sandbox, sandbox);
const md = sandbox.MarkdownLite;

/**
 * 断言输出里不存在**可执行的**结构。
 *
 * 注意不能用「输出里是否出现 onerror=」这种子串判断：被转义后的可见文本
 * （例如 `&lt;img src=x onerror=alert(1)&gt;`）本来就应当原样展示，它不是
 * 可执行内容。所以要检查的是「标签内部」和「URL 属性」。
 */
function assertNoExecutableHtml(html, label) {
  // 结构性标签：转义后只会以 &lt;script&gt; 形式出现，不会匹配这些正则。
  assert.ok(!/<script/i.test(html), `${label}: 不应出现 <script>`);
  assert.ok(!/<iframe/i.test(html), `${label}: 不应出现 <iframe>`);
  assert.ok(!/<svg/i.test(html), `${label}: 不应出现 <svg>`);
  assert.ok(!/<object|<embed|<form/i.test(html), `${label}: 不应出现 object/embed/form`);

  // 真实标签内部不允许出现事件处理器属性
  for (const tag of html.match(/<[a-zA-Z][^>]*>/g) || []) {
    assert.ok(!/\son[a-z]+\s*=/i.test(tag), `${label}: 标签内出现事件处理器 → ${tag}`);
  }
  // URL 属性里不允许出现可执行协议
  for (const attr of html.match(/(?:href|src)\s*=\s*"[^"]*"/gi) || []) {
    assert.ok(!/javascript:|vbscript:|data:text\/html/i.test(attr), `${label}: URL 属性出现危险协议 → ${attr}`);
  }
}

test('原始 HTML 一律被转义，不会进入输出', () => {
  const html = md.render('<script>alert(1)</script>');
  assertNoExecutableHtml(html, 'raw script');
  assert.ok(html.includes('&lt;script&gt;'), '应当以转义形式呈现');
});

test('块级原始 HTML 同样被转义', () => {
  const html = md.render('<div onclick="steal()">hi</div>\n\n<iframe src="//evil"></iframe>');
  assertNoExecutableHtml(html, 'block html');
});

test('内联事件处理器属性不会被执行', () => {
  const html = md.render('<img src=x onerror=alert(1)>');
  assertNoExecutableHtml(html, 'img onerror');
});

test('javascript: 链接被降级为纯文本', () => {
  const html = md.render('[click](javascript:alert(1))');
  assertNoExecutableHtml(html, 'js link');
  assert.ok(!/<a /.test(html), '不应当生成链接');
  assert.ok(html.includes('click'), '链接文字应保留');
});

test('大小写混淆与控制字符的 javascript: 也被拦截', () => {
  for (const payload of ['JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', '  javascript:alert(1)']) {
    const html = md.render(`[x](${payload})`);
    assertNoExecutableHtml(html, `payload ${payload}`);
  }
});

test('vbscript / data: 协议被拦截，http/https/mailto/相对路径放行', () => {
  assert.ok(!/<a /.test(md.render('[x](vbscript:msgbox)')));
  assert.ok(!/<a /.test(md.render('[x](data:text/html,<b>)')));
  assert.ok(md.render('[x](https://example.com/a)').includes('href="https://example.com/a"'));
  assert.ok(md.render('[x](mailto:a@b.c)').includes('href="mailto:a@b.c"'));
  assert.ok(md.render('[x](/docs/a.md)').includes('href="/docs/a.md"'));
  assert.ok(md.render('[x](docs/a.md)').includes('href="docs/a.md"'));
});

test('图片的 src 也经过协议白名单', () => {
  const bad = md.render('![a](javascript:alert(1))');
  assertNoExecutableHtml(bad, 'img js');
  assert.ok(!/<img/.test(bad), '不应当生成 img');
  const good = md.render('![a](https://example.com/a.png)');
  assert.ok(good.includes('<img src="https://example.com/a.png"'));
  assert.ok(good.includes('alt="a"'));
  assert.ok(good.includes('loading="lazy"'));
  assertNoExecutableHtml(good, 'good img');
});

test('外链带 noopener noreferrer，内链不带', () => {
  assert.ok(md.render('[a](https://x.com)').includes('rel="noopener noreferrer"'));
  assert.ok(!md.render('[a](/local)').includes('target="_blank"'));
});

test('代码围栏内容被转义而不是执行', () => {
  const html = md.render('```html\n<script>alert(1)</script>\n```');
  assertNoExecutableHtml(html, 'fence');
  assert.ok(html.includes('<pre><code class="language-html">'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('常用语法渲染正确', () => {
  assert.ok(md.render('# 标题').includes('<h1>标题</h1>'));
  assert.ok(md.render('## 二级').includes('<h2>二级</h2>'));
  assert.ok(md.render('**粗**').includes('<strong>粗</strong>'));
  assert.ok(md.render('*斜*').includes('<em>斜</em>'));
  assert.ok(md.render('`code`').includes('<code>code</code>'));
  assert.ok(md.render('~~删~~').includes('<del>删</del>'));
  assert.ok(md.render('---').includes('<hr>'));
  assert.ok(md.render('> 引用').includes('<blockquote>引用</blockquote>'));
  assert.ok(md.render('- a\n- b').includes('<ul>') && md.render('- a\n- b').includes('<li>a</li>'));
  assert.ok(md.render('1. a\n2. b').includes('<ol>'));
});

test('列表会被正确闭合', () => {
  const html = md.render('- a\n- b\n\n段落');
  assert.ok(html.includes('</ul>'), '列表必须闭合');
  assert.ok(html.indexOf('</ul>') < html.indexOf('<p>段落</p>'), '列表应在段落之前闭合');
});

test('未闭合的代码围栏仍然被转义并闭合', () => {
  const html = md.render('```\n<script>x</script>');
  assertNoExecutableHtml(html, 'unclosed fence');
  assert.ok(html.includes('</code></pre>'));
});

test('行内代码里的星号不会被当作强调', () => {
  const html = md.render('`a*b*c`');
  assert.ok(html.includes('<code>a*b*c</code>'));
  assert.ok(!html.includes('<em>'));
});

test('空输入与 null 不抛错', () => {
  assert.equal(md.render(''), '');
  assert.equal(md.render(null), '');
  assert.equal(md.render(undefined), '');
});

test('超长输入不会因递归而崩溃', () => {
  const html = md.render('a'.repeat(200000));
  assert.ok(html.startsWith('<p>'));
});
