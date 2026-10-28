#!/usr/bin/env node
/**
 * 增长内容矩阵守卫（实施书 P3-T3.1）
 *
 * 内容不是代码，但它一样会"腐烂"，而且更难发现：
 *   - 20 条内容改编号后，旧文件还留在 xhs/ 里 → 日历与实际发布对不上；
 *   - 渠道码重复一个，两个不同内容的归因就永远混在一起，**事后无法拆开**；
 *   - seed.json 改了但没重跑生成脚本 → 落地页还是旧文案（比文件缺失更难看出来）。
 *
 * 所以这里检查四件事：
 *   ① seed.json 自身合法：20 条、编号 1–20 唯一、必填字段齐、风险信号 ≥2；
 *   ② 每条内容在 xhs/ 与 dy/ 各有一个 Markdown，且正文里带着自己的渠道码；
 *   ③ js/land-cases.js 覆盖全部 40 个渠道码（20 × 2 平台），并导出 landCase；
 *   ④ 落地页三件套接好：land.html 引 js/land.js，CTA 指向 advice/pitfalls。
 *
 * 注意：这是**一致性**检查，不判断文案好坏 —— 文案好坏只能人看。
 *
 * 用法：node tools/scripts/check-growth-content.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const LIB = path.join(ROOT, 'docs', '增长', '内容库');
const SEED = path.join(LIB, 'seed.json');

const problems = [];
const pad = (n) => String(n).padStart(2, '0');

/* ---------- ① seed.json ---------- */
if (!fs.existsSync(SEED)) {
  console.error(`❌ 缺少 ${path.relative(ROOT, SEED)}`);
  process.exit(1);
}
let seed;
try {
  seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
} catch (err) {
  console.error(`❌ seed.json 不是合法 JSON：${err.message}`);
  process.exit(1);
}

const items = Array.isArray(seed.items) ? seed.items : [];
if (items.length !== 20) problems.push(`内容条数 ${items.length}，实施书要求 20`);

const seenNo = new Set();
for (const it of items) {
  const tag = `第 ${it?.no} 条`;
  if (!Number.isInteger(it?.no) || it.no < 1 || it.no > 20) problems.push(`${tag}：编号非法 ${JSON.stringify(it?.no)}`);
  else if (seenNo.has(it.no)) problems.push(`${tag}：编号重复`);
  else seenNo.add(it.no);
  for (const f of ['case', 'category', 'hook', 'comment']) {
    if (!it?.[f]) problems.push(`${tag}：缺字段 ${f}`);
  }
  if (!it?.xhs?.title || !it?.xhs?.body) problems.push(`${tag}：小红书标题或正文缺失`);
  for (const f of ['hook', 'case', 'turn', 'guide']) {
    if (!it?.dy?.[f]) problems.push(`${tag}：抖音脚本缺 ${f}`);
  }
  if (!Array.isArray(it?.signals) || it.signals.length < 2) problems.push(`${tag}：风险信号少于 2 条`);
  if (typeof it?.dy?.hook === 'string' && it.dy.hook.length > 90) {
    problems.push(`${tag}：抖音钩子 ${it.dy.hook.length} 字，5 秒念不完（>90 字）`);
  }
}
if (seenNo.size === 20) {
  for (const n of seenNo) if (!seenNo.has(n)) problems.push(`编号缺口：${n}`);
}

/* ---------- ② 每条内容两份 Markdown，且带着自己的渠道码 ---------- */
for (const it of items) {
  for (const [dir, prefix] of [
    ['xhs', 'xhs'],
    ['dy', 'dy'],
  ]) {
    const abs = path.join(LIB, dir);
    if (!fs.existsSync(abs)) {
      problems.push(`缺少目录 docs/增长/内容库/${dir}`);
      continue;
    }
    const hits = fs.readdirSync(abs).filter((f) => f.startsWith(`${pad(it.no)}-`) && f.endsWith('.md'));
    if (hits.length !== 1) {
      problems.push(`${dir}/ 第 ${it.no} 条应恰好 1 个文件，实际 ${hits.length} 个`);
      continue;
    }
    const body = fs.readFileSync(path.join(abs, hits[0]), 'utf8');
    const code = `${prefix}${pad(it.no)}`;
    if (!body.includes(code)) problems.push(`${dir}/${hits[0]}：正文里没有渠道码 ${code}`);
    if (!body.includes('初稿')) problems.push(`${dir}/${hits[0]}：缺少"初稿，发布前需人工审校"标注`);
  }
}

/* ---------- ③ js/land-cases.js 覆盖 40 个码 ---------- */
const casesFile = path.join(ROOT, 'js', 'land-cases.js');
if (!fs.existsSync(casesFile)) {
  problems.push('缺少 js/land-cases.js（应运行 node tools/scripts/gen-growth-content.mjs 生成）');
} else {
  const js = fs.readFileSync(casesFile, 'utf8');
  if (!/export const LAND_CASES\s*=/.test(js)) problems.push('js/land-cases.js 未导出 LAND_CASES');
  if (!/export function landCase\s*\(/.test(js)) problems.push('js/land-cases.js 未导出 landCase()');
  for (const it of items) {
    for (const prefix of ['xhs', 'dy']) {
      const code = `${prefix}${pad(it.no)}`;
      if (!js.includes(`${code}: {`)) problems.push(`js/land-cases.js 缺渠道码 ${code}`);
    }
  }
}

/* ---------- ③b 渠道码表 40 行 ---------- */
const codeTable = path.join(LIB, '渠道码表.md');
if (!fs.existsSync(codeTable)) {
  problems.push('缺少 docs/增长/内容库/渠道码表.md');
} else {
  const txt = fs.readFileSync(codeTable, 'utf8');
  const rows = txt.split('\n').filter((l) => /^\|\s*`(xhs|dy)\d{2}`/.test(l));
  if (rows.length !== 40) problems.push(`渠道码表应有 40 行，实际 ${rows.length} 行`);
  // 重复码：同一码出现两次，归因就永久混在一起
  const codes = rows.map((l) => l.match(/`((?:xhs|dy)\d{2})`/)[1]);
  const dup = codes.filter((c, i) => codes.indexOf(c) !== i);
  if (dup.length) problems.push(`渠道码表存在重复码：${[...new Set(dup)].join(', ')}`);
}

/* ---------- ④ 落地页接线 ---------- */
const land = path.join(ROOT, 'land.html');
if (!fs.existsSync(land)) {
  problems.push('缺少 land.html');
} else {
  const src = fs.readFileSync(land, 'utf8');
  if (!src.includes('js/land.js')) problems.push('land.html 未引入 js/land.js');
  if (!src.includes('js/layout.js')) problems.push('land.html 未引入 js/layout.js（导航/统计会缺失）');
  if (!/advice\.html\?sku=diagnose/.test(src)) problems.push('land.html 主 CTA 未指向 advice.html?sku=diagnose');
  if (!/href="pitfalls\.html"/.test(src)) problems.push('land.html 次 CTA 未指向 pitfalls.html');
  if (!src.includes('css/land.css')) problems.push('land.html 未引入 css/land.css');
}
for (const f of ['css/land.css', 'js/land.js']) {
  if (!fs.existsSync(path.join(ROOT, f))) problems.push(`缺少 ${f}`);
}

/* ---------- 汇总 ---------- */
if (problems.length) {
  console.error(`❌ 增长内容矩阵 ${problems.length} 处问题：`);
  for (const p of problems.slice(0, 40)) console.error(`  · ${p}`);
  if (problems.length > 40) console.error(`  · ……还有 ${problems.length - 40} 处`);
  process.exit(1);
}
console.log(`✅ 20 条内容 × 2 平台 · 40 个渠道码 · 落地页接线正常`);
