/** G3 内容层：FAQPage schema ×12（从案例库真实数据生成）+ BreadcrumbList ×3 → 注入 advice.html */
import fs from 'node:fs';
import path from 'node:path';
process.chdir(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..'));

const dataSrc = [fs.readFileSync('js/data-extra.js', 'utf8'), fs.readFileSync('js/data.js', 'utf8')].join('\n')
  .replace(/^import[^\n]*$/gm, '')
  .replace(/\bexport const\b/g, 'const')
  .replace(/\bexport default\b/g, '');
const { PITFALLS } = new Function(dataSrc + '; return { PITFALLS };')();

const top = [...PITFALLS].sort((a, b) => (b.helped || 0) - (a.helped || 0)).slice(0, 12);
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const faqEntities = top.map((c) => ({
  '@type': 'Question',
  name: c.quiz.q,
  acceptedAnswer: {
    '@type': 'Answer',
    text: `${c.quiz.options[c.quiz.a]}。${c.lesson}（来源：Q问案例库 · 帮助 ${c.helped} 人）`,
  },
}));

const faqSchema = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: faqEntities,
}, null, 1);

const breadcrumb = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: [
    { '@type': 'ListItem', position: 1, name: '首页', item: 'https://qtvq.cn/' },
    { '@type': 'ListItem', position: 2, name: '避坑大全', item: 'https://qtvq.cn/pitfalls.html' },
    { '@type': 'ListItem', position: 3, name: '避坑诊断 · 关系复盘' },
  ],
}, null, 1);

// 注入 advice.html（FAQ 主页面）
let s = fs.readFileSync('advice.html', 'utf8');
if (!s.includes('FAQPage')) {
  s = s.replace('</head>', `  <script type="application/ld+json">\n${faqSchema}\n  </script>\n  <script type="application/ld+json">\n${breadcrumb}\n  </script>\n</head>`);
  fs.writeFileSync('advice.html', s, 'utf8');
  console.log('advice.html: FAQPage(12 Q) + BreadcrumbList 已注入');
}

// pitfalls.html：仅 Breadcrumb
let p = fs.readFileSync('pitfalls.html', 'utf8');
if (!p.includes('BreadcrumbList')) {
  const bc = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: '首页', item: 'https://qtvq.cn/' },
      { '@type': 'ListItem', position: 2, name: '避坑大全' },
    ],
  }, null, 1);
  p = p.replace('</head>', `  <script type="application/ld+json">\n${bc}\n  </script>\n</head>`);
  fs.writeFileSync('pitfalls.html', p, 'utf8');
  console.log('pitfalls.html: BreadcrumbList 已注入');
}

// help.html：FAQPage（使用帮助高频问题，独立 6 条）
const helpFaq = [
  { q: 'Q问免费吗？', a: '每 24 小时 5 次提问完全免费，无需注册。会员 ¥29/月 起不限次数。' },
  { q: 'AI 回答可靠吗？', a: '回答基于 50 条真实案例库与境内大模型，每个回答附三步行动方案；不承诺效果，仅提供参考。' },
  { q: '我的隐私安全吗？', a: '匿名提问不存姓名联系方式；数据境内存储；支持一键导出与注销。' },
  { q: '未成年人能用吗？', a: '本产品仅面向 18–30 岁成年人，未满 18 周岁一律拒绝服务。' },
  { q: '转盘配对是真人吗？', a: '候选池只包含真实注册并完善资料的用户，绝不虚构。' },
  { q: '付费后能退款吗？', a: '报告生成失败自动原路退款；会员未到期注销需联系客服协商。' },
];
const helpSchema = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: helpFaq.map((f) => ({
    '@type': 'Question',
    name: f.q,
    acceptedAnswer: { '@type': 'Answer', text: f.a },
  })),
}, null, 1);
let h = fs.readFileSync('help.html', 'utf8');
if (!h.includes('FAQPage')) {
  h = h.replace('</head>', `  <script type="application/ld+json">\n${helpSchema}\n  </script>\n</head>`);
  fs.writeFileSync('help.html', h, 'utf8');
  console.log('help.html: FAQPage(6 Q) 已注入');
}
process.exit(0);
