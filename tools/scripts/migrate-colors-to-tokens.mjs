#!/usr/bin/env node
/**
 * 把小程序页面里的硬编码色值迁移到设计令牌（Phase 1 · 第 2 步）
 *
 * 背景
 * ----
 * `packages/tokens` 已建立唯一来源，但页面里仍有约 150 处十六进制色值。
 * 不替换它们，令牌就只是"存在"，并不产生一致性的约束力。
 *
 * 做两件事
 * --------
 *   1. 把纯 CSS 的 `<style>` 升级为 `<style lang="scss">`（SCSS 是 CSS 超集，风险极低），
 *      否则 `uni.scss` 注入的 SCSS 变量在这些页面里不可用；
 *   2. 在 **`<style>` 块内部**把已登记到令牌的十六进制色值替换成 `$color-*`。
 *
 * 安全边界（严格）
 * ----------------
 *   · 只改 `<style …>…</style>` 区间，**不碰模板与 JS**（避免动到 `:style="{color:'#6c5ce7'}"` 这类绑定）；
 *   · 只替换 `#rrggbb` 六位十六进制，跳过 `#fff`/`#000` 三位、跳过 `url(...)` 内部；
 *   · 只替换**已登记**的 15 个令牌色；未登记的颜色原样保留并计入报告，由人决定是否入册。
 *
 * 用法
 * ----
 *   node tools/scripts/migrate-colors-to-tokens.mjs            # 预演，只报告
 *   node tools/scripts/migrate-colors-to-tokens.mjs --apply    # 实际写入
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const UNI_SRC = path.join(ROOT, 'apps/qtvq-uni/src');
const APPLY = process.argv.includes('--apply');

const { COLOR } = await import(
  new URL('../../packages/tokens/src/index.js', import.meta.url).href
);

function kebab(s) {
  return s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
}

/** hex(小写) → 变量名，例如 '#ff6b81' → '$color-pink' */
const HEX_TO_VAR = new Map();
for (const [k, v] of Object.entries(COLOR)) {
  HEX_TO_VAR.set(String(v).toLowerCase(), `$color-${kebab(k)}`);
}

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.vue')) out.push(p);
  }
  return out;
}

const STYLE_RE = /<style(\s[^>]*)?>([\s\S]*?)<\/style>/g;

const report = {
  filesScanned: 0,
  filesChanged: 0,
  scssAdded: [],
  replaced: 0,
  perVar: new Map(),
  unknown: new Map(),
};

for (const file of walk(UNI_SRC)) {
  report.filesScanned += 1;
  const src = fs.readFileSync(file, 'utf8');
  let changed = false;
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');

  const next = src.replace(STYLE_RE, (full, attrs = '', body = '') => {
    // 1) 补 lang="scss"
    let newAttrs = attrs || '';
    if (!/lang\s*=/.test(newAttrs)) {
      newAttrs = newAttrs.replace(/^(\s*)/, '$1') + ' lang="scss"';
      // 保持属性顺序自然：<style scoped> → <style lang="scss" scoped>
      newAttrs = newAttrs.replace(/^(\s*)lang="scss"(\s+scoped)?$/, '$1lang="scss"$2');
      changed = true;
      report.scssAdded.push(rel);
    }

    // 2) 替换 body 内的已知色值（跳过 url(...) 内部）
    const newBody = body.replace(/url\([^)]*\)|#[0-9a-fA-F]{6}\b/g, (m) => {
      if (m.startsWith('url(')) return m;
      const key = m.toLowerCase();
      const v = HEX_TO_VAR.get(key);
      if (v) {
        report.replaced += 1;
        report.perVar.set(v, (report.perVar.get(v) || 0) + 1);
        changed = true;
        return v;
      }
      report.unknown.set(key, (report.unknown.get(key) || 0) + 1);
      return m;
    });

    return `<style${newAttrs}>${newBody}</style>`;
  });

  if (changed) {
    report.filesChanged += 1;
    if (APPLY) fs.writeFileSync(file, next, 'utf8');
  }
}

console.log(`模式: ${APPLY ? 'APPLY（写入）' : 'DRY-RUN（只报告）'}`);
console.log(`扫描 .vue: ${report.filesScanned} 个，需改动: ${report.filesChanged} 个`);
console.log(`补 lang="scss": ${report.scssAdded.length} 处`);
report.scssAdded.forEach((f) => console.log(`  + ${f}`));
console.log(`替换色值: ${report.replaced} 处`);
[...report.perVar.entries()]
  .sort((a, b) => b[1] - a[1])
  .forEach(([k, n]) => console.log(`  ${k.padEnd(26)} ${n}`));

const unknown = [...report.unknown.entries()].sort((a, b) => b[1] - a[1]);
if (unknown.length) {
  console.log(`\n未登记颜色（保留原值，需人工决定是否入册）: ${unknown.length} 个`);
  unknown.slice(0, 12).forEach(([k, n]) => console.log(`  ${k}  ${n} 次`));
}

if (!APPLY) console.log('\nDRY-RUN 结束。确认后执行：node tools/scripts/migrate-colors-to-tokens.mjs --apply');
