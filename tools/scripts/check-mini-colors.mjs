#!/usr/bin/env node
/**
 * 小程序 / 鸿蒙端「野色」检查（配色是否真的与主平台同源）
 *
 * 为什么要有
 * ----------
 * `packages/tokens` + `gen-tokens` 解决了"**产物**是否漂移"（check-all 里那一项），
 * 但解决不了"**页面里又手写了一个色值**"。2026-10-28 实测：
 *   · 小程序 62 处硬编码色值里，有 10 个值在主站**根本不存在**：
 *     `#8b8aa0` `#9090a8` `#2a2a3d` `#232333` `#e74c3c` `#ff7675` `#9b8cff` `#c0392b` `#07c160`（当时未入册）`#fff`
 *   · 其中 account.vue 一个文件就发明了 3 档不同的"危险红"（#e74c3c / #ff7675 / #c0392b），
 *     而主站只有一档（rgba(255,92,92,α) + #ff8080）。跨端看就是"两套设计"。
 * 这类偏差不会报错、不会崩，只会让用户觉得"小程序像是另一个产品"。所以只能断言。
 *
 * 断言
 * ----
 *   1. `apps/qtvq-uni/src` 与 `apps/qtvq-uniappx` 里出现的每个十六进制色值，
 *      必须能在 `packages/tokens` 的 COLOR 里找到同值（白/黑作为通用基色放行）
 *   2. **注释不算**：注释里为了说明历史可以写野色（本项目大量注释都这么写），
 *      把它们算进断言会让"解释为什么改"反而触发失败 —— 检查器要读代码，不读散文
 *
 * 为什么两端都查：鸿蒙（uvue）不支持 SCSS 变量注入，只能写字面量；
 * 那就更需要"值必须等于令牌"这条约束，否则它是唯一没人管的一端。
 */
import fs from 'node:fs';
import path from 'node:path';
import { COLOR } from '../../packages/tokens/src/index.js';

const ROOT = process.cwd();
const problems = [];

/** 通用基色：不属于品牌色，任何端都可以直接用 */
const UNIVERSAL = new Set(['#ffffff', '#000000']);

/** #abc / #abcd 展开成 6/8 位，避免同一个白色写成两种形式就漏判 */
function expand(hex) {
  const h = hex.toLowerCase();
  if (h.length === 4) return '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  if (h.length === 5) return '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3] + h[4] + h[4];
  return h;
}

const ALLOWED = new Set([...Object.values(COLOR).map((v) => expand(String(v).trim())), ...UNIVERSAL]);

/**
 * 去掉注释再扫。
 * 顺序要紧：先整块去 `/* *&#47;`，再逐行去 `//`；`//` 判定要跳过 `://`（URL）。
 */
function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out
    .split(/\r?\n/)
    .map((line) => {
      const idx = line.indexOf('//');
      if (idx === -1) return line;
      // URL（https://…）或转义斜杠不算注释
      if (idx > 0 && line[idx - 1] === ':') return line;
      return line.slice(0, idx);
    })
    .join('\n');
  return out;
}

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (/node_modules|dist|unpackage|\.git/.test(entry.name)) continue;
      walk(p, acc);
    } else {
      acc.push(p);
    }
  }
  return acc;
}

const targets = [
  ...walk(path.join(ROOT, 'apps', 'qtvq-uni', 'src')).filter((f) => /\.(vue|scss|css)$/.test(f)),
  ...walk(path.join(ROOT, 'apps', 'qtvq-uniappx')).filter((f) => /\.(uvue|uts)$/.test(f)),
];

let scanned = 0;
for (const file of targets) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const code = stripComments(fs.readFileSync(file, 'utf8'));
  code.split(/\r?\n/).forEach((line, i) => {
    const hits = line.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    for (const raw of hits) {
      scanned += 1;
      if (!ALLOWED.has(expand(raw))) {
        problems.push(`${rel}:${i + 1}  ${raw} 不在 packages/tokens 里（主站没有这个色值）`);
      }
    }
  });
}

if (problems.length === 0) {
  console.log(
    `[check-mini-colors] ✅ ${targets.length} 个文件 / ${scanned} 处色值，全部可在 packages/tokens 中找到同值`,
  );
  process.exit(0);
}

console.error(`[check-mini-colors] ❌ ${problems.length} 处野色（主站不存在的色值）：`);
for (const p of problems.slice(0, 40)) console.error('  ' + p);
if (problems.length > 40) console.error(`  … 另有 ${problems.length - 40} 处`);
console.error('  修法：改用 $color-* 变量；确实需要新色，先入册 packages/tokens 再重跑 gen-tokens');
process.exit(1);
