#!/usr/bin/env node
/**
 * 检查所有 .ps1 是否带 UTF-8 BOM。
 *
 * 为什么需要它：仓库里 core.autocrlf=true，且 Windows PowerShell 5.1 在**没有 BOM** 时
 * 会按系统 ANSI 码页解码 .ps1 —— 中文注释一旦被解成引号/括号类字节，脚本会直接解析失败。
 * 实测已经发生过两次：`package-static.ps1` 与 `push-all.ps1` 都曾处于"无法运行"状态
 * （报 `Unexpected token` / `The string is missing the terminator`），而且不跑到才会发现。
 *
 * 更隐蔽的是：**任何编辑器/工具重写文件都可能把 BOM 丢掉**，改完看着没问题，一到
 * Windows PowerShell 里就崩。所以放进自检，而不是靠记性。
 *
 * 用法：node tools/scripts/check-ps1-bom.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BOM = [0xef, 0xbb, 0xbf];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.wrangler']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.name.toLowerCase().endsWith('.ps1')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const files = walk(ROOT);
const missing = [];
const nonAsciiWithoutBom = [];

for (const f of files) {
  const b = fs.readFileSync(f);
  const hasBom = b.length >= 3 && b[0] === BOM[0] && b[1] === BOM[1] && b[2] === BOM[2];
  const body = hasBom ? b.subarray(3) : b;
  const hasNonAscii = body.some((x) => x > 0x7f);
  if (!hasBom) {
    missing.push(path.relative(ROOT, f));
    if (hasNonAscii) nonAsciiWithoutBom.push(path.relative(ROOT, f));
  }
}

// --fix：把丢失的 BOM 补回去（幂等）
if (process.argv.includes('--fix')) {
  let fixed = 0;
  for (const rel of missing) {
    const f = path.join(ROOT, rel);
    const b = fs.readFileSync(f);
    fs.writeFileSync(f, Buffer.concat([Buffer.from(BOM), b]));
    fixed += 1;
  }
  console.log(`[check-ps1-bom] 已补回 BOM：${fixed} 个`);
  if (fixed > 0) {
    console.log('[check-ps1-bom] 请重新跑一次不带 --fix 的检查确认');
  }
  process.exit(0);
}

console.log(`[check-ps1-bom] 扫描 ${files.length} 个 .ps1`);

if (files.length === 0) {
  console.log('[check-ps1-bom] ✅ 没有 .ps1 文件');
  process.exit(0);
}

if (missing.length === 0) {
  console.log('[check-ps1-bom] ✅ 全部带 UTF-8 BOM');
  process.exit(0);
}

console.error(`[check-ps1-bom] ❌ ${missing.length} 个文件缺少 UTF-8 BOM：`);
for (const f of missing) console.error(`  - ${f}${nonAsciiWithoutBom.includes(f) ? '   ← 含非 ASCII，必崩' : ''}`);
console.error('');
console.error('修复（PowerShell 一行，逐条给路径）：');
console.error(
  "  $f='tools\\scripts\\xxx.ps1'; $b=[IO.File]::ReadAllBytes($f); " +
    "[IO.File]::WriteAllBytes($f, [byte[]](0xEF,0xBB,0xBF)+$b)",
);
console.error('或直接跑：node tools/scripts/check-ps1-bom.mjs --fix');
process.exit(1);
