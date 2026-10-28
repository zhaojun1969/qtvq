/**
 * 死胡同审计：找出"点了没反应 / 跳到不存在的地方"的地方。
 *
 * 检查三类：
 *   ① 内部链接指向的文件是否存在（含 #锚点是否存在）
 *   ② 带 id 的按钮/可点元素，是否有任何 JS 引用它（没有 = 点了没反应）
 *   ③ 页脚/导航里引用的页面是否都在包内
 */
import fs from 'node:fs';
import path from 'node:path';

const pages = ['index.html', 'pitfalls.html', 'profile.html', 'wheel.html', 'report.html', 'account.html', 'help.html', 'download.html', 'privacy.html', '404.html', 'wechat-callback.html'];
const jsFiles = fs.readdirSync('js').filter((f) => f.endsWith('.js')).map((f) => path.join('js', f));
const allJs = jsFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
// 页面内联脚本同样会绑定事件（如 wechat-callback.html），必须算进来，
// 否则会把"内联脚本处理的事件"误报成死胡同（2026-09-18 实际误报过一次）。
const inlineJs = pages
  .filter((p) => fs.existsSync(p))
  .map((p) => [...fs.readFileSync(p, 'utf8').matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n'))
  .join('\n');
const allJsWithInline = allJs + '\n' + inlineJs;

let problems = 0;
const note = (s) => {
  console.log('  ❌ ' + s);
  problems += 1;
};

/* ① 内部链接 */
console.log('=== ① 内部链接与锚点 ===');
for (const p of pages) {
  if (!fs.existsSync(p)) continue;
  const h = fs.readFileSync(p, 'utf8');
  const links = [...h.matchAll(/href="([^"#][^"]*|#[^"]+)"/g)].map((m) => m[1]);
  for (const raw of new Set(links)) {
    if (/^(https?:|mailto:|tel:|javascript:)/.test(raw)) continue;
    const [file, hash] = raw.split('#');
    if (!file) {
      const target = fs.readFileSync(p, 'utf8');
      if (hash && !new RegExp(`id="${hash}"`).test(target)) note(`${p} → 锚点 #${hash} 不存在`);
      continue;
    }
    const abs = file.split('?')[0];
    if (!fs.existsSync(abs)) {
      note(`${p} → ${raw}（文件不存在）`);
      continue;
    }
    if (hash && abs.endsWith('.html')) {
      const t = fs.readFileSync(abs, 'utf8');
      if (!new RegExp(`id="${hash}"`).test(t)) note(`${p} → ${raw}（目标页无此锚点）`);
    }
  }
}

/* ② 按钮是否有 JS 处理 */
console.log('=== ② 可点元素（带 id）是否有 JS 引用 ===');
const IGNORE = new Set(['pay-qr-viewer', 'subscribe-modal', 'wx-login-modal', 'topup-panel', 'wx-login-box']);
for (const p of pages) {
  if (!fs.existsSync(p)) continue;
  const h = fs.readFileSync(p, 'utf8');
  const ids = [...new Set([...h.matchAll(/<button[^>]*\bid="([^"]+)"/g)].map((m) => m[1]))];
  for (const id of ids) {
    if (IGNORE.has(id)) continue;
    // 表单内的提交按钮由 form 的 submit 处理，允许无 id 引用
    const inForm = new RegExp(`<form[^>]*>[\\s\\S]{0,3000}?id="${id}"`).test(h);
    const referenced = allJsWithInline.includes(`'${id}'`) || allJsWithInline.includes(`"${id}"`) || allJsWithInline.includes(`#${id}`);
    if (!referenced && !inForm) note(`${p} → #${id} 没有被任何 JS 引用（点了可能没反应）`);
  }
}

/* ③ 导航/页脚页面是否齐全 */
console.log('=== ③ 导航与页脚引用的页面 ===');
const layout = fs.readFileSync('js/layout.js', 'utf8');
const navFiles = [...layout.matchAll(/href:\s*'([\w.-]+\.html)'/g)].map((m) => m[1]);
for (const f of new Set(navFiles)) {
  if (!fs.existsSync(f)) note(`导航指向的 ${f} 不存在`);
}
console.log(`  导航项：${[...new Set(navFiles)].join(', ')}`);

console.log('');
console.log(problems === 0 ? '✅ 未发现死胡同（内部链接、锚点、按钮引用、导航页面全部有效）' : `❌ 共发现 ${problems} 处问题`);
