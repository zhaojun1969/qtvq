/**
 * 全站链接清点（v2）：空链 · 死链 · 循环重定向 —— 本地引用 + 线上实测双轨
 *
 * 与 audit-dead-ends.mjs 的分工：
 *   audit-dead-ends 管「点了没反应」（JS 绑定级）；本脚本管「URL 层的联通性」：
 *   ① 本地相对引用 → 仓库文件存在性
 *   ② 线上页面（qtvq.cn 实际下发的 HTML）里的每一条 href/src → 真实 HTTP 探测
 *   ③ 重定向链逐跳跟随（≤6 跳），出现已访问 URL 即判「循环重定向」
 *   ④ href="" / href="#" 空链清点
 *
 * 用法：node tools/scripts/audit-links-live.mjs
 * 退出码：0 全过；1 有死链/环/空链（逐条列出）。
 *
 * 安全约束（Mimosa）：仅 http/https；发请求前校验 host，拒绝 localhost/环回/
 * 私有/保留地址。
 */
import fs from 'node:fs';
import path from 'node:path';

const ORIGIN = 'https://qtvq.cn';
const TIMEOUT = 10000;
const MAX_HOPS = 6;

let problems = 0;
const bad = (m) => { problems += 1; console.log('  ❌ ' + m); };
const warn = (m) => { console.log('  ⚠️ ' + m); };
const ok = (m) => console.log('  ✅ ' + m);

// ---------- URL 安全校验（Mimosa） ----------
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '0.0.0.0') return true;
  if (h === '::1' || h.startsWith('fc00:') || h.startsWith('fe80:')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}
function safeUrl(u) {
  let parsed;
  try { parsed = new URL(u); } catch { return null; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (isPrivateHost(parsed.hostname)) return null;
  return parsed;
}

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'manual' });
  } finally { clearTimeout(t); }
}

/** 跟随重定向（≤MAX_HOPS），返回 {status, chain, loop} */
async function probe(url, method = 'GET') {
  const chain = [url];
  const seen = new Set([url]);
  let current = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    let res;
    try { res = await fetchWithTimeout(current, { method: hop === 0 ? method : 'GET' }); }
    catch (e) { return { status: 0, chain, error: String(e.message || e).slice(0, 80), loop: false }; }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) return { status: res.status, chain, error: '重定向无 Location', loop: false };
      const next = safeUrl(new URL(loc, current).href);
      if (!next) return { status: res.status, chain, error: `重定向目标非法: ${loc.slice(0, 60)}`, loop: false };
      if (seen.has(next.href)) return { status: res.status, chain, loop: true };
      seen.add(next.href); chain.push(next.href); current = next.href; continue;
    }
    return { status: res.status, chain, loop: false };
  }
  return { status: 0, chain, error: `超过 ${MAX_HOPS} 跳仍未落地`, loop: false };
}

// ---------- ① 本地引用 → 文件存在性 ----------
console.log('=== ① 本地 HTML 引用 → 仓库文件存在性 ===');
const htmlFiles = fs.readdirSync('.').filter((f) => f.endsWith('.html'));
const localBroken = new Map();
for (const page of htmlFiles) {
  const src = fs.readFileSync(page, 'utf8');
  const refs = [...src.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (!ref || ref === '#' || ref.startsWith('#') || /^(https?:|data:|javascript:|mailto:|tel:)/i.test(ref)) continue;
    const file = ref.split(/[?#]/)[0];
    if (!file) continue;
    if (!fs.existsSync(file)) {
      if (!localBroken.has(page)) localBroken.set(page, []);
      localBroken.get(page).push(ref);
    }
  }
}
if (localBroken.size === 0) ok(`本地 ${htmlFiles.length} 个页面相对引用全部存在`);
else for (const [p, refs] of localBroken) bad(`${p} 引用不存在的文件：${[...new Set(refs)].join('、')}`);

// ---------- ② 空链清点（本地源码层） ----------
console.log('\n=== ② 空链清点（href="" / href="#"） ===');
let emptyTotal = 0;
for (const page of htmlFiles) {
  const src = fs.readFileSync(page, 'utf8');
  const empties = [...src.matchAll(/href=""|href="#"/g)].length;
  if (empties) { warn(`${page}：${empties} 处空链（href="#"/""）`); emptyTotal += empties; }
}
if (emptyTotal === 0) ok('无空链');

// ---------- ③ 线上页面逐页探测 ----------
console.log('\n=== ③ 线上页面探测（含重定向链） ===');
const pageResults = [];
for (const page of htmlFiles) {
  const r = await probe(`${ORIGIN}/${page}`);
  pageResults.push({ page, ...r });
  const chainStr = r.chain.length > 1 ? ` → 跳转 ${r.chain.length - 1} 次` : '';
  if (r.loop) bad(`${page} 循环重定向：${r.chain.join(' → ')}`);
  else if (r.error) bad(`${page} HTTP ${r.status} ${r.error}`);
  else if (r.status !== 200) bad(`${page} HTTP ${r.status}${chainStr}`);
  else ok(`${page} 200${chainStr}`);
}

// ---------- ④ 线上下发 HTML 内的链接逐一探测 ----------
console.log('\n=== ④ 线上首页/账户/避坑/下载页内链接逐一探测 ===');
const probePages = ['index.html', 'account.html', 'pitfalls.html', 'download.html', 'help.html'];
const urlCache = new Map();
let deadLinks = 0;
for (const page of probePages) {
  let res;
  try { res = await fetchWithTimeout(`${ORIGIN}/${page}`); } catch { warn(`${page} 抓取失败，跳过`); continue; }
  if (res.status !== 200) { warn(`${page} HTTP ${res.status}，跳过`); continue; }
  const html = await res.text();
  const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1])
    .filter((u) => u && !u.startsWith('#') && !u.startsWith('data:') && !u.startsWith('javascript:') && !u.startsWith('mailto:'));
  const unique = [...new Set(refs)];
  let pageDead = 0;
  for (const ref of unique) {
    const abs = safeUrl(new URL(ref, `${ORIGIN}/${page}`).href);
    if (!abs) continue;
    const key = abs.origin + abs.pathname + abs.search;
    if (!urlCache.has(key)) {
      const r = await probe(key, 'HEAD');
      let status = r.status;
      // 一些源对 HEAD 返回 405，回落 GET
      if (status === 405 || status === 0) {
        const g = await probe(key, 'GET');
        status = g.status;
        urlCache.set(key, { status, loop: g.loop, error: g.error, chain: g.chain });
      } else {
        urlCache.set(key, { status, loop: r.loop, error: r.error, chain: r.chain });
      }
    }
    const c = urlCache.get(key);
    if (c.loop || c.status === 0 || c.status >= 400) {
      pageDead += 1;
      bad(`${page} → ${key}  HTTP ${c.status || 'ERR'}${c.loop ? ' 循环重定向' : ''}${c.error ? ' ' + c.error : ''}`);
    }
  }
  console.log(`  · ${page}：${unique.length} 条链接，死链 ${pageDead}`);
  deadLinks += pageDead;
}
if (deadLinks === 0) ok('线上页面内链接全部可达（含外域）');

// ---------- 汇总 ----------
console.log(`\n=== 结论：${problems === 0 ? '链接层全过' : problems + ' 条问题（死链/环/缺失）'}；空链 ${emptyTotal} 处（人工复核项） ===`);
process.exit(problems === 0 ? 0 : 1);
