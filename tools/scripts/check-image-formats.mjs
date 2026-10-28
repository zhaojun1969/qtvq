#!/usr/bin/env node
/**
 * 图片格式守卫（C2 性能优化 · 图片）
 *
 * 三件事：
 *   ① 每个 `<picture>` 必须含**恰好一个** `<img>` 兜底 —— 否则老浏览器直接不显示图；
 *      收款码不显示的后果是"用户付不了钱"，不是"图裂了"那么简单。
 *   ② `srcset` 引用的文件必须存在，且 WebP 必须**小于**对应源图 ——
 *      实测无损 WebP 并非处处更小（`qr-alipay-scan.png` 97KB → 205KB），
 *      上线一个更大的变体等于把页面越优化越慢。
 *   ③ 同目录存在 `.webp` 兄弟文件的图片，必须通过 `<picture>` 引用它 ——
 *      否则那个 WebP 就是死文件：占仓库体积，用户一个字节也省不到。
 *
 * 用法：
 *   node tools/scripts/check-image-formats.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const problems = [];

/* ---------- ① 扫描 HTML 里的 <picture> 与 <img> ---------- */

const htmlFiles = fs.readdirSync(ROOT).filter((n) => n.endsWith('.html'));

for (const name of htmlFiles) {
  const src = fs.readFileSync(path.join(ROOT, name), 'utf8');

  // ① picture 必须有且仅有一个 img 兜底
  for (const m of src.matchAll(/<picture\b[^>]*>([\s\S]*?)<\/picture>/g)) {
    const inner = m[1];
    const imgs = [...inner.matchAll(/<img\b/g)];
    if (imgs.length !== 1) {
      problems.push(`${name}: 一个 <picture> 里有 ${imgs.length} 个 <img>（必须恰好 1 个作为兜底）`);
    }
    const sources = [...inner.matchAll(/<source\b[^>]*srcset="([^"]+)"/g)].map((x) => x[1]);
    for (const s of sources) {
      // ② srcset 引用的文件必须存在
      const clean = (s.split(/\s+/)[0] || '').split('?')[0];
      if (!clean || /^(https?:)?\/\//.test(clean)) continue;
      const abs = path.join(ROOT, clean);
      if (!fs.existsSync(abs)) {
        problems.push(`${name}: srcset 指向的文件不存在 → ${clean}`);
      }
    }
  }
}

/* ---------- ②③ WebP 与源图的大小 / 引用关系 ---------- */

const IMG_DIRS = ['assets', 'logo'];
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const imgFiles = IMG_DIRS.flatMap((d) => walk(path.join(ROOT, d)));

const allHtml = htmlFiles.map((n) => fs.readFileSync(path.join(ROOT, n), 'utf8')).join('\n');

for (const abs of imgFiles) {
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  if (!rel.endsWith('.webp')) continue;

  const webpSize = fs.statSync(abs).size;
  const srcPng = abs.replace(/\.webp$/i, '.png');
  const srcJpg = abs.replace(/\.webp$/i, '.jpg');

  // ② WebP 必须小于源图
  const sourceSize = fs.existsSync(srcPng)
    ? fs.statSync(srcPng).size
    : fs.existsSync(srcJpg)
      ? fs.statSync(srcJpg).size
      : null;
  if (sourceSize !== null && webpSize >= sourceSize) {
    problems.push(
      `${rel}: WebP（${(webpSize / 1024).toFixed(1)}KB）不小于源图（${(sourceSize / 1024).toFixed(1)}KB）—— 不该上线`,
    );
  }

  // ③ 必须被 <picture> 引用，否则是死文件
  if (!allHtml.includes(rel)) {
    problems.push(`${rel}: 没有任何页面通过 <picture> 引用它（死文件，应删除或接入）`);
  }
}

if (problems.length === 0) {
  const webpCount = imgFiles.filter((f) => f.endsWith('.webp')).length;
  console.log(`[check-image-formats] ✅ ${htmlFiles.length} 个页面、${webpCount} 个 WebP 变体：兜底完整、体积更小、均被引用`);
  process.exit(0);
}

console.error(`[check-image-formats] ❌ ${problems.length} 处不合格：`);
for (const p of problems) console.error('  ' + p);
console.error('\n说明：收款码这类"扫不出来就付不了钱"的图片，必须保留 <img> 兜底与原格式。');
process.exit(1);
