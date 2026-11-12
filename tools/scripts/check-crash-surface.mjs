/**
 * crash-surface 检查器（E.91）：Express 4 不捕获 async rejection，
 * Node 22 默认崩进程 —— 路由处理器里任何一个未捕获的 throw 都能让整站 502。
 *
 * 判据：`router.METHOD(...)` 的处理器若为裸 async（未套 wrap），
 * 则从处理器起点起的 700 字符内必须出现 `try {`（全量守卫），否则记为崩溃地雷。
 * 事故原型：E.86 contact.js 引用顺序错误 → 首个 POST 崩掉进程 → systemd 重启循环。
 *
 * 用法：node tools/scripts/check-crash-surface.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
const DIR = path.join(ROOT, 'server', 'src', 'routes');

let problems = 0;
const flag = (m) => { problems += 1; console.log('  ❌ ' + m); };

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(DIR, f), 'utf8');
  const re = /router\.(get|post|put|patch|delete)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    const start = m.index;
    const end = m.index + m[0].length;
    const win = src.slice(end, end + 200);
    // 已套 wrap → 安全
    if (/wrap\s*\(\s*(async\b|$)/.test(win)) continue;
    // 具名非内联处理器（无 inline async）→ 不在本检查器判定范围，人工审
    const asyncOffset = win.search(/\basync\s*\(/);
    if (asyncOffset === -1) continue;
    const head = src.slice(start, start + 700);
    const tryOffset = head.indexOf('async');
    if (/try\s*\{/.test(head.slice(tryOffset))) continue;
    problems += 1;
    flag(`${f}:${line} ${m.group(1)} 裸 async 且头部无 try —— 崩溃地雷（套 wrap 或全量 try/catch）`);
  }
}

console.log(problems === 0 ? '\n✅ crash-surface 全守卫' : `\n❌ ${problems} 处崩溃地雷`);
process.exit(problems === 0 ? 0 : 1);
