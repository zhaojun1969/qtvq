#!/usr/bin/env node
/**
 * 共享层纯度检查（Phase 1 · 守护 L0–L3）
 *
 * 目的
 * ----
 * `packages/shared`、`packages/tokens`（以及未来的 `packages/i18n`、`packages/safety`）
 * 是跨端共享的**唯一来源**。它们必须**零平台依赖**：不能出现 `window`、`document`、
 * `uni`、`wx`、`fetch`、`process`、`Buffer` 等任何与运行时绑定的标识符。
 *
 * 一旦有人在共享层写了 `window.location`，网页能跑、小程序就会崩，而且**构建不会报错**
 * —— 这种破坏是静默的。本检查器把"静默"变成"判红"。
 *
 * 判定规则
 * --------
 *   1. 扫描 packages 下每个包的 src 目录里的 .js 文件；
 *   2. 先剥离注释与字符串字面量（避免把字符串里的 "window" 误判）；
 *   3. 在剩余代码里查找**自由标识符**（前面不是 `.` 的 `\bword\b`）；
 *   4. 命中即报红，输出 `文件:行号: 标识符`。
 *
 * 不禁止的东西（刻意）
 * --------------------
 *   · `import` / `export` —— ESM 语法本身不是平台 API；
 *   · `setTimeout` / `setInterval` —— 跨平台通用（浏览器 + Node + 小程序都有）；
 *   · `globalThis` —— ES2020 规范的一部分，不是平台专属；
 *   · `Math` / `JSON` / `Date` / `Array` / `Object` / `String` / `Number` / `Promise`
 *     / `Error` / `RegExp` / `Map` / `Set` / `Symbol` / `Reflect` / `Proxy`
 *     —— JS 语言内置，所有环境都有。
 *
 * 用法
 * ----
 *   node tools/scripts/check-shared-purity.mjs            # 扫描，命中即退码 1
 *   node tools/scripts/check-shared-purity.mjs --self-test # 注入一条违规，验证能抓到
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SELF_TEST = process.argv.includes('--self-test');

/** 被禁止的平台专属标识符 */
const FORBIDDEN = [
  // ---- 浏览器 ----
  'window', 'document', 'navigator', 'location', 'history', 'screen',
  'localStorage', 'sessionStorage', 'fetch', 'XMLHttpRequest', 'WebSocket',
  'alert', 'confirm', 'prompt',
  'createElement', 'getElementById', 'querySelector', 'querySelectorAll',
  'addEventListener', 'removeEventListener',
  'requestAnimationFrame', 'cancelAnimationFrame',
  'IntersectionObserver', 'MutationObserver', 'ResizeObserver',
  'getComputedStyle', 'matchMedia',
  'crypto', // 浏览器 window.crypto 与 Node node:crypto 不同源；共享层不应直接用全局 crypto
  // ---- 小程序 ----
  'uni', 'wx', 'my', 'tt', 'swan', 'getApp', 'getCurrentPages',
  // ---- Node（共享层是 ESM 纯数据/纯函数，不应依赖 Node 运行时）----
  'process', 'Buffer', 'require', '__dirname', '__filename',
  'global', 'module', 'exports',
];

/** JS 语言内置，所有环境都有，不禁止 */
const ALLOWED_BUILTINS = new Set([
  'Math', 'JSON', 'Date', 'Array', 'Object', 'String', 'Number',
  'Boolean', 'Promise', 'Error', 'RegExp', 'Map', 'Set', 'WeakMap',
  'WeakSet', 'Symbol', 'Reflect', 'Proxy', 'ArrayBuffer', 'Uint8Array',
  'DataView', 'TextEncoder', 'TextDecoder', 'BigInt', 'Infinity', 'NaN',
  'undefined', 'null', 'true', 'false', 'console',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'globalThis', 'queueMicrotask',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI', 'decodeURI',
  'encodeURIComponent', 'decodeURIComponent',
]);

function stripCommentsAndStrings(src) {
  /*
   * 必须用**单一合并正则**、按"块注释 | 行注释 | 模板串 | 双引号串 | 单引号串"的顺序扫描，
   * 并把命中内容替换成**保留换行的空格**：
   *   · 分开多轮替换会互相破坏——先剥行注释会把 "https?://…" 字符串里的 `//` 当注释咬掉，
   *     留下未闭合的引号，导致后面的字符串配对错位、**该剥的没剥掉**（words.js 的 wx 误报就是这么来的）；
   *   · 合并正则里字符串是原子匹配，扫描遇到 `"` 就把整个串吃掉，串内的 `//` 不会被误剥；
   *   · 保留换行是为了**行号与原文对齐**，报错位置才可信。
   */
  return src.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,
    (m) => m.replace(/[^\n]/g, ' '),
  );
}

function scanFile(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  const stripped = stripCommentsAndStrings(src);
  const strippedLines = stripped.split('\n');
  const violations = [];

  for (let i = 0; i < strippedLines.length; i++) {
    const line = strippedLines[i];
    for (const id of FORBIDDEN) {
      // 自由标识符：前面不是 '.'
      const re = new RegExp(`(?<![.\\w])\\b${id}\\b`, 'g');
      let m;
      while ((m = re.exec(line)) !== null) {
        // 排除：它是某个对象的方法名（obj.id）—— 已被 lookbehind 排除
        // 排除：它是声明名（function id / const id / let id / var id / class id）
        // —— 声明名本身不构成"使用"，但如果声明了又用了，用的地方会报
        const before = line.slice(0, m.index);
        if (/\b(function|const|let|var|class|import|from|as)\s*$/.test(before)) continue;
        violations.push({ file: filePath, line: i + 1, id, snippet: lines[i]?.trim().slice(0, 100) || '' });
      }
    }
  }
  return violations;
}

function walkPackages() {
  const packagesDir = path.join(ROOT, 'packages');
  if (!fs.existsSync(packagesDir)) return [];
  const files = [];
  for (const pkg of fs.readdirSync(packagesDir)) {
    const srcDir = path.join(packagesDir, pkg, 'src');
    if (!fs.existsSync(srcDir)) continue;
    for (const name of fs.readdirSync(srcDir)) {
      if (name.endsWith('.js')) files.push(path.join(srcDir, name));
    }
  }
  return files;
}

const files = walkPackages();
if (files.length === 0) {
  console.log('[check-shared-purity] packages/*/src 下无 .js 文件，跳过');
  process.exit(0);
}

let allViolations = [];
for (const f of files) {
  const v = scanFile(f);
  allViolations.push(...v);
}

if (SELF_TEST) {
  // 人为注入一条违规到临时文件，验证检查器能抓到
  const tmpFile = path.join(ROOT, 'packages', '_selftest_tmp', 'src', 'injected.js');
  fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
  fs.writeFileSync(tmpFile, 'export const x = window.location.href;\n', 'utf8');
  const v = scanFile(tmpFile);
  fs.rmSync(path.dirname(path.dirname(tmpFile)), { recursive: true, force: true });
  if (v.length > 0) {
    console.log('  ✓ 自测通过：注入 `window` 后检查器判红');
    console.log(`    ${path.relative(ROOT, v[0].file)}:${v[0].line}  ${v[0].id}`);
  } else {
    console.error('  ✗ 自测失败：注入 `window` 后检查器未判红');
    process.exit(1);
  }
  // 自测不影响正式结果
  process.exit(allViolations.length > 0 ? 1 : 0);
}

if (allViolations.length === 0) {
  console.log(`[check-shared-purity] ✅ 扫描 ${files.length} 个文件，零平台 API 依赖`);
  process.exit(0);
}

console.error(`[check-shared-purity] ❌ 发现 ${allViolations.length} 处平台 API 依赖：`);
for (const v of allViolations) {
  console.error(`  ${path.relative(ROOT, v.file)}:${v.line}  → ${v.id}`);
  console.error(`    ${v.snippet}`);
}
console.error('\n共享层（packages/*/src）禁止出现任何平台专属标识符。');
console.error('如需平台差异，由各端自己包一层，而不是把平台 API 塞进共享层。');
process.exit(1);
