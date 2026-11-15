/** G1 技术层一次性执行（E.105）：OG 全站注入 + OG 品牌卡生成 + sitemap lastmod + llms-full + IndexNow key */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';

process.chdir(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..'));

const MAGENTA = '#cc4560', PURPLE = '#6c5ce7', INK = '#0f0e17', TEXT = '#f5f5f7';

// ---- ① OG 品牌卡 1200×630（resvg 生成，品牌渐变+logo 环+标语）----
const ogSvg = `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${MAGENTA}"/><stop offset="1" stop-color="${PURPLE}"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="${INK}"/>
  <rect x="60" y="60" width="1080" height="510" rx="24" fill="none" stroke="url(#bg)" stroke-width="3" opacity="0.9"/>
  <text x="600" y="240" text-anchor="middle" font-family="PingFang SC,Microsoft YaHei,sans-serif" font-size="96" font-weight="bold" fill="${TEXT}" letter-spacing="20">Q 问</text>
  <text x="600" y="340" text-anchor="middle" font-family="PingFang SC,Microsoft YaHei,sans-serif" font-size="40" fill="#c8c8d8" letter-spacing="6">问出爱情真谛</text>
  <text x="600" y="440" text-anchor="middle" font-family="PingFang SC,Microsoft YaHei,sans-serif" font-size="26" fill="#a0a0b0">情感避坑 · AI 智慧问答 · 50 条真实案例</text>
  <text x="600" y="520" text-anchor="middle" font-family="PingFang SC,Microsoft YaHei,sans-serif" font-size="18" fill="#7c7a8c">qtvq.cn · 仅面向 18–30 岁成年人</text>
</svg>`;
fs.mkdirSync('assets', { recursive: true });
fs.writeFileSync('assets/og-card.png', new Resvg(ogSvg, { fitTo: { mode: 'width', value: 1200 }, background: 'rgba(15,14,23,1)' }).render().asPng());
console.log('OG 品牌卡: assets/og-card.png (1200×630)');

// ---- ② OG 标签注入 15 页（title/description 从页面自身取）----
const pages = fs.readdirSync('.').filter((f) => f.endsWith('.html'));
let ogAdded = 0;
for (const f of pages) {
  let s = fs.readFileSync(f, 'utf8');
  if (s.includes('property="og:title"')) continue;
  const title = (s.match(/<title>([^<]+)<\/title>/) || [])[1] || '我心永恒 - Q问';
  const desc = (s.match(/name="description" content="([^"]*)"/) || [])[1] || '情感避坑 + AI 智慧问答';
  const isSensitive = /noindex/.test(s);
  const og = [
    `<meta property="og:title" content="${title.replace(/"/g, '&quot;')}">`,
    `<meta property="og:description" content="${desc.replace(/"/g, '&quot;')}">`,
    `<meta property="og:image" content="https://qtvq.cn/assets/og-card.png">`,
    `<meta property="og:url" content="https://qtvq.cn/${f}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="我心永恒 - Q问">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ].join('\n  ');
  s = s.replace('<meta name="viewport"', og + '\n  <meta name="viewport"');
  // 敏感页不让 OG 出卡片（noindex 页 OG 无意义，去掉 og:image/og:url 防分享泄漏）
  if (isSensitive) s = s.replace(/<meta property="og:(image|url)"[^>]*>\n?/g, '');
  fs.writeFileSync(f, s, 'utf8');
  ogAdded++;
}
console.log(`OG 注入: ${ogAdded}/${pages.length} 页`);

// ---- ③ sitemap lastmod（当前构建日期）----
const today = new Date().toISOString().slice(0, 10);
let sm = fs.readFileSync('sitemap.xml', 'utf8');
if (!sm.includes('<lastmod>')) {
  sm = sm.replace(/(<loc>https:\/\/qtvq\.cn\/[^<]+<\/loc>)/g, '$1\n    <lastmod>' + today + '</lastmod>');
  fs.writeFileSync('sitemap.xml', sm, 'utf8');
}
console.log('sitemap lastmod:', (sm.match(/<lastmod>/g) || []).length, '处');

// ---- ④ llms-full.txt（50 条案例结构化，从 data.js 生成）----
/* E.105：data.js 是浏览器 ESM（根 package.json 无 type:module），Node 动态 import 会解析失败。
 * 改为读文本、剥 import/export、沙箱求值——案例数据是纯字面量，安全。 */
const dataSrc = [fs.readFileSync('js/data-extra.js', 'utf8'), fs.readFileSync('js/data.js', 'utf8')].join('\n')
  .replace(/^import[^\n]*$/gm, '')
  .replace(/\bexport const\b/g, 'const')
  .replace(/\bexport default\b/g, '');
const { PITFALLS, CATEGORIES } = new Function(dataSrc + '; return { PITFALLS, CATEGORIES };')();
const lines = [
  '# 我心永恒 - Q问 · 案例库全文（llms-full）',
  '',
  '> 50 条真实情感避坑案例。每条含：类别、标题、核心教训（可直接引用）、三步行动方案。',
  '> 数据来源：真实用户案例整理，帮助人数为站内统计。产品仅面向 18–30 岁成年人。',
  '> 引用规范：注明「来源：Q问案例库 qtvq.cn」。',
  '',
];
for (const cat of CATEGORIES) {
  const items = PITFALLS.filter((x) => x.category === cat);
  if (!items.length) continue;
  lines.push(`## ${cat}`);
  for (const c of items) {
    lines.push(`- ${c.title}：${c.lesson} 行动：${c.steps.replace(/\n/g, '；')}（帮助 ${c.helped} 人）`);
  }
  lines.push('');
}
lines.push(`## 数据总览`);
lines.push(`- 案例总数：${PITFALLS.length}`);
lines.push(`- 类别：${CATEGORIES.join('、')}`);
lines.push(`- 累计帮助：${PITFALLS.reduce((s, c) => s + (c.helped || 0), 0)} 人次`);
fs.writeFileSync('llms-full.txt', lines.join('\n'), 'utf8');
console.log('llms-full.txt:', lines.length, '行（', PITFALLS.length, '条案例全覆盖）');

// ---- ⑤ IndexNow key（Bing/Seznam/Yandex 共用）----
const keyFile = crypto.randomUUID();
fs.writeFileSync(keyFile + '.txt', keyFile, 'utf8');
console.log('IndexNow key 文件:', keyFile + '.txt');
process.exit(0);
