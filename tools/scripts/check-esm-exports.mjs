#!/usr/bin/env node
/**
 * ES 模块导入/导出交叉校验
 *
 * 起因（2026-10-26）：一处 `config.js` 的导出名从 DIRECT_MAX_MS 改为 PROBE_MAX_MS，
 * 而 api-fetch.js 的 import 已同步、config.js 的改动却因脚本写法失败没落地。
 * `node --check` 对两个文件**各自都通过**——只有在浏览器里加载时才会
 * `SyntaxError: The requested module does not provide an export named ...`，
 * 表现为整站 JS 全挂。这类"单文件合法、组合即错"的问题必须由加载级校验兜住。
 *
 * 做法：扫描 js/ 下所有 .js，解析 `import { a, b } from './某个本地模块.js'`，
 * 逐个核对目标文件是否真的导出了这些名字。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SCAN_DIRS = ['js'];

function listJs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out.push(...listJs(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

function exportsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const as = /\s+as\s+([A-Za-z0-9_$]+)$/.exec(seg);
      names.add(as ? as[1] : seg.split(/\s+/)[0]);
    }
  }
  if (/^export\s+default/m.test(src)) names.add('default');
  return names;
}

const files = SCAN_DIRS.flatMap((d) => listJs(path.join(ROOT, d)));
const problems = [];

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), m[2]);
    if (!fs.existsSync(target)) {
      problems.push(`${path.relative(ROOT, file)}: 导入的文件不存在 ${m[2]}`);
      continue;
    }
    const available = exportsOf(target);
    for (const part of m[1].split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const name = /\s+as\s+/.test(seg) ? seg.split(/\s+as\s+/)[0].trim() : seg;
      if (!available.has(name)) {
        problems.push(
          `${path.relative(ROOT, file)}: 从 ${m[2]} 导入 ${name}，但对方没有导出（现有：${[...available].join(', ')}）`,
        );
      }
    }
  }
}

if (problems.length === 0) {
  console.log(`[check-esm-exports] ✅ ${files.length} 个模块，导入导出全部对得上`);
  process.exit(0);
}
console.error(`[check-esm-exports] ❌ ${problems.length} 处不匹配：`);
for (const p of problems) console.error('  ' + p);
process.exit(1);
