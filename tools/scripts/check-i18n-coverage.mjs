#!/usr/bin/env node
/**
 * i18n 覆盖检查（Phase 1 · 守护文案目录完整性）
 *
 * 做两件事
 * --------
 *   1. 扫描所有源码里的 `t('key')` 调用，检查 key 是否在 zh-CN.js 中有定义；
 *   2. 反向检查 zh-CN.js 里的 key 是否被引用（未引用的 key 可能是死代码）。
 *
 * 用法
 * ----
 *   node tools/scripts/check-i18n-coverage.mjs            # 扫描，命中即退码 1
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

// 加载文案目录
const zhCNModule = await import(
  new URL('../../packages/i18n/src/zh-CN.js', import.meta.url).href
);
const zhCN = zhCNModule.default;
const definedKeys = new Set(Object.keys(zhCN));

// 扫描范围：小程序 Vue/JS、官网 JS、HTML
const SCAN_GLOBS = [
  'apps/qtvq-uni/src',
  'js',
];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(vue|js|html)$/.test(name)) out.push(p);
  }
  return out;
}

const files = [];
for (const g of SCAN_GLOBS) {
  walk(path.join(ROOT, g), files);
}
// HTML 在根目录
for (const f of fs.readdirSync(ROOT).filter((n) => n.endsWith('.html'))) {
  files.push(path.join(ROOT, f));
}

// 提取所有 t('key') 调用
const usedKeys = new Map(); // key → [{file, line}]
const T_CALL_RE = /\bt\(\s*['"]([^'"]+)['"]/g;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let m;
    T_CALL_RE.lastIndex = 0;
    while ((m = T_CALL_RE.exec(lines[i])) !== null) {
      const key = m[1];
      if (!usedKeys.has(key)) usedKeys.set(key, []);
      usedKeys.get(key).push({ file: path.relative(ROOT, file), line: i + 1 });
    }
  }
}

// 检查：引用了但未定义
const missing = [];
for (const [key, refs] of usedKeys) {
  if (!definedKeys.has(key)) {
    missing.push({ key, refs });
  }
}

// 检查：定义了但未引用
const unused = [];
for (const key of definedKeys) {
  if (!usedKeys.has(key)) {
    unused.push(key);
  }
}

if (missing.length === 0 && unused.length === 0) {
  console.log(`[check-i18n-coverage] ✅ ${definedKeys.size} 个键全部覆盖（${usedKeys.size} 处引用）`);
  process.exit(0);
}

if (missing.length > 0) {
  console.error(`[check-i18n-coverage] ❌ ${missing.length} 个键被引用但未定义：`);
  for (const { key, refs } of missing) {
    console.error(`  "${key}"  ← ${refs[0].file}:${refs[0].line}`);
  }
}

if (unused.length > 0) {
  console.error(`[check-i18n-coverage] ⚠ ${unused.length} 个键已定义但未被引用：`);
  for (const key of unused) {
    console.error(`  "${key}"`);
  }
}

process.exit(missing.length > 0 ? 1 : 0);
