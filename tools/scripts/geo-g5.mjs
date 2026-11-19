/** G3 内容层 GEO 化（E.110）：pitfalls.html 注入可抓取的静态案例区（50 例语义 HTML + ItemList schema）
 *
 * 为什么：案例库当前由 JS 渲染（爬虫不执行 JS = 案例内容对搜索引擎/AI 引擎不可见）。
 * 本脚本在 `pitfall-grid` 挂载点**之前**注入一个静态语义区块（<section id="cases-crawlable">）：
 *   · 每案例 <article id="case-{id}">：类别/标题/教训/三步行动/帮助数（全部真实数据）；
 *   · ItemList JSON-LD（50 项，GEO 引用结构）；
 *   · 交互层（筛选/测验/卡片）不受影响——JS 渲染继续在后续区块工作。
 * 幂等：重复运行自动跳过（以 cases-crawlable 标记判断）。
 */
import fs from 'node:fs';
import path from 'node:path';
process.chdir(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..'));

const dataSrc = [fs.readFileSync('js/data-extra.js', 'utf8'), fs.readFileSync('js/data.js', 'utf8')].join('\n')
  .replace(/^import[^\n]*$/gm, '')
  .replace(/\bexport const\b/g, 'const')
  .replace(/\bexport default\b/g, '');
const { PITFALLS, CATEGORIES } = new Function(dataSrc + '; return { PITFALLS, CATEGORIES };')();

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ItemList schema（50 项，GEO 引用结构）
const itemList = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  name: '情感避坑案例库',
  numberOfItems: PITFALLS.length,
  itemListElement: PITFALLS.map((c, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    item: {
      '@type': 'Article',
      headline: `${c.category} · ${c.title}`,
      description: c.lesson?.slice(0, 160) || '',
    },
  })),
}, null, 1);

// 静态语义 HTML（每案例 article + 锚点）
const articles = PITFALLS.map((c) => {
  const steps = String(c.steps || '').split('\n').filter(Boolean).map((s) => `<li>${esc(s)}</li>`).join('');
  return `<article class="case-item" id="case-${c.id}">
  <h3>${esc(c.category)} · ${esc(c.title)}</h3>
  <p class="case-lesson">${esc(c.lesson)}</p>
  ${steps ? `<ol class="case-steps">${steps}</ol>` : ''}
  <p class="case-meta">帮助 ${c.helped || 0} 人 · 来源：Q问真实案例库</p>
</article>`;
}).join('\n');

const staticBlock = `<!-- E.110 内容层 GEO：可抓取的静态案例区（JS 交互层在其后独立渲染） -->
<section id="cases-crawlable" aria-label="情感避坑案例库（可抓取全文）">
  <h2>情感避坑案例库（50 条真实案例）</h2>
  <p class="section-sub">以下为案例库全文的静态呈现；交互式筛选与测验请使用上方工具。</p>
${articles}
</section>
<script type="application/ld+json">
${itemList}
</script>
<!-- /cases-crawlable -->`;

// 注入 pitfalls.html：pitfall-grid 挂载点之前
const page = 'pitfalls.html';
let s = fs.readFileSync(page, 'utf8');
if (s.includes('id="cases-crawlable"')) {
  console.log('已存在，跳过（幂等）');
  process.exit(0);
}
const mount = s.indexOf('<div class="pitfall-grid" id="pitfall-grid"></div>');
if (mount === -1) throw new Error('pitfall-grid 挂载点未找到');
s = s.slice(0, mount) + staticBlock + '\n' + s.slice(mount);

// 注入 ItemList schema（head 内，跟已有 JSON-LD 并列）
if (!s.includes('ItemList')) {
  s = s.replace('</head>', `  <script type="application/ld+json">\n${itemList}\n  </script>\n</head>`);
}
fs.writeFileSync(page, s, 'utf8');
console.log('pitfalls.html: 静态案例区 + ItemList schema 已注入（案例', PITFALLS.length, '条）');
