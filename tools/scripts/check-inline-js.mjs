/**
 * HTML 内联脚本语法检查
 *
 * 为什么需要它：网站的十几个页面里都有内联 `<script>`，而 `node --check` 只认 `.js` 文件。
 * 手改内联脚本时少一个括号、多一个反引号，浏览器就整段不执行 ——
 * 表现是"页面能打开、点了没反应"，控制台也只有一条 SyntaxError。
 * 这类错误没有任何构建步骤会拦，只能显式检查。
 *
 * 做法：抽出每个 `<script>`（跳过带 src 的），用 `vm.Script` 只编译不执行 ——
 * 语法错误立刻定位到「HTML 第几行起的那一段」。
 *
 * 用法：
 *   node tools/scripts/check-inline-js.mjs                 # 扫仓库里的静态页
 *   node tools/scripts/check-inline-js.mjs server/public/console.html
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

/** 默认扫描范围：仓库根目录的静态页 + 服务端托管的后台页 */
function defaultTargets() {
  const out = [];
  for (const dir of [ROOT, path.join(ROOT, 'server/public')]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.html')) continue;
      if (name === '404.html') continue; // 纯静态错误页，无内联脚本
      out.push(path.join(dir, name));
    }
  }
  return out.sort();
}

function checkFile(file) {
  const html = fs.readFileSync(file, 'utf8');
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const problems = [];
  let m;
  let total = 0;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    /* 数据型 script 不是可执行 JavaScript。
     * 例如首页 SEO 的 application/ld+json，按 JS 编译会误报 `Unexpected token ':'`。
     * 这里只跳过明确声明的非 JS 类型，普通内联脚本仍按原规则检查。 */
    const typeMatch = attrs.match(/\btype\s*=\s*["']?([^\s"'>]+)/i);
    const scriptType = typeMatch ? typeMatch[1].toLowerCase() : '';
    const executableTypes = new Set([
      '',
      'module',
      'text/javascript',
      'application/javascript',
      'application/ecmascript',
      'text/ecmascript',
    ]);
    if (!executableTypes.has(scriptType)) continue;
    const code = m[2];
    if (!code.trim()) continue;
    total++;
    const line = html.slice(0, m.index).split('\n').length;
    const isModule = /\btype\s*=\s*["']?module/i.test(attrs);
    try {
      if (isModule) {
        // `<script type="module">` 允许 import/export，vm.Script 会误报
        // “Cannot use import statement outside a module”；交给 node --check 按 ESM 解析。
        const tmp = path.join(os.tmpdir(), `qtvq-inline-${process.pid}-${total}.mjs`);
        fs.writeFileSync(tmp, code, 'utf8');
        const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
        fs.unlinkSync(tmp);
        if (r.status !== 0) {
          const msg = (r.stderr || '').split('\n').filter((l) => /Error|error/.test(l))[0] || '语法错误';
          throw new Error(msg.trim());
        }
      } else {
        // 只编译，不执行；给出可读的文件名便于定位
        new vm.Script(code, { filename: `${path.relative(ROOT, file)}:${line}` });
      }
    } catch (err) {
      problems.push({ line, message: err.message });
    }
  }
  return { total, problems };
}

const args = process.argv.slice(2).map((p) => path.resolve(ROOT, p));
const targets = args.length ? args : defaultTargets();

let files = 0;
let scripts = 0;
let bad = 0;
for (const file of targets) {
  if (!fs.existsSync(file)) {
    console.log(`❌ 文件不存在：${path.relative(ROOT, file)}`);
    bad++;
    continue;
  }
  const { total, problems } = checkFile(file);
  if (!total) continue;
  files++;
  scripts += total;
  if (problems.length) {
    bad += problems.length;
    for (const p of problems) {
      console.log(`❌ ${path.relative(ROOT, file)}（第 ${p.line} 行起的内联脚本）：${p.message}`);
    }
  }
}

console.log(
  bad
    ? `\n内联脚本检查：${files} 个文件 / ${scripts} 段脚本，语法错误 ${bad} 处`
    : `✅ 内联脚本：${files} 个文件 / ${scripts} 段脚本，语法全部通过`
);
process.exit(bad ? 1 : 0);
