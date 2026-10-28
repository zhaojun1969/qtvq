/**
 * 线上静态资源体检：递归抓取页面依赖的 JS/CSS，逐个校验"能拿到 + 语法合法"
 *
 * 为什么需要它：`curl index.html` 返回 200 **不代表页面能用**。
 * 只要有一个被 import 的模块 404 或者语法错误，浏览器里就是白屏/半死 ——
 * 而 curl 每个文件单独看都是"能访问"。用户报"网站打不开"时，这类问题最难自查，
 * 因为服务端日志全绿。
 *
 * 用法：
 *   node tools/scripts/check-live-assets.mjs                 # 体检默认首页
 *   node tools/scripts/check-live-assets.mjs /download.html  # 指定页面
 *   node tools/scripts/check-live-assets.mjs / --all-pages   # 顺带体检所有根目录页面
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE = process.env.QTVQ_API_BASE || 'https://qtvq.cn';
const args = process.argv.slice(2);
const allPages = args.includes('--all-pages');
const pageArg = args.find((a) => a.startsWith('/')) || '/';

let fail = 0;
const bad = (m) => {
  console.log(`  ❌ ${m}`);
  fail += 1;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qtvq-live-'));

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
  return { status: res.status, type: res.headers.get('content-type') || '', text: res.status === 200 ? await res.text() : '' };
}

/** 从 ESM 源码里抽出静态 import/export-from 的目标 */
function extractImports(src) {
  const out = new Set();
  const re = /(?:^|\n)\s*(?:import|export)[^'"\n]*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  // 动态 import('...')
  const re2 = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = re2.exec(src)) !== null) out.add(m[1]);
  return [...out];
}

/** 把相对路径解析成站内绝对 URL */
function resolveUrl(from, spec) {
  if (/^https?:\/\//.test(spec)) return null; // 外链跳过
  return new URL(spec, from).href;
}

async function checkPage(page) {
  const url = `${BASE}${page}`;
  console.log(`=== 体检 ${url} ===`);
  const html = await fetchText(url);
  if (html.status !== 200) {
    bad(`页面本身 HTTP ${html.status}`);
    return;
  }
  console.log(`  页面 HTTP 200，${html.text.length} 字节`);

  // 页面引用的所有本地资源（script src / link href）
  const refs = [];
  for (const m of html.text.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const v = m[1];
    if (/^(https?:|mailto:|#|data:)/.test(v)) continue;
    refs.push(new URL(v, url).href);
  }
  const seen = new Set();
  const queue = [...refs];
  const problems = [];
  let okCount = 0;

  while (queue.length) {
    const target = queue.shift();
    if (seen.has(target)) continue;
    seen.add(target);
    let res;
    try {
      res = await fetchText(target);
    } catch (err) {
      problems.push(`${target} 请求失败：${err.message}`);
      continue;
    }
    if (res.status !== 200) {
      problems.push(`${target} → HTTP ${res.status}`);
      continue;
    }
    okCount += 1;

    const isJs = target.endsWith('.js') || res.type.includes('javascript');
    if (!isJs) continue;

    // 语法校验：写成 .mjs 让 node 按 ESM 解析
    const file = path.join(tmp, `m${seen.size}.mjs`);
    fs.writeFileSync(file, res.text, 'utf8');
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      problems.push(`${target} 语法错误：${String(err.stderr || err.message).split('\n').slice(0, 3).join(' ')}`);
    }

    // 递归跟进它 import 的模块
    for (const spec of extractImports(res.text)) {
      const abs = resolveUrl(target, spec);
      if (abs && abs.startsWith(BASE) && !seen.has(abs)) queue.push(abs);
    }
  }

  console.log(`  依赖资源：${okCount} 个可访问，共 ${seen.size} 个`);
  if (problems.length === 0) {
    console.log('  ✅ 全部可达且 JS 语法合法');
  } else {
    for (const p of problems) bad(p);
  }
}

try {
  await checkPage(pageArg);
  if (allPages) {
    const home = await fetchText(`${BASE}/`);
    const pages = [...home.text.matchAll(/href="([a-z0-9-]+\.html)"/gi)].map((m) => `/${m[1]}`);
    for (const p of [...new Set(pages)]) {
      console.log('');
      await checkPage(p);
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('');
console.log(fail === 0 ? '✅ 线上资源体检通过' : `❌ 共 ${fail} 处问题`);
process.exit(fail ? 1 : 0);
