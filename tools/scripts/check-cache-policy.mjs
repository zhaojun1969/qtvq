#!/usr/bin/env node
/**
 * 线上缓存策略校验（C2 性能）
 *
 * 为什么要有：2026-10-26 发现站点同时存在两个互相抵消的配置 ——
 *   ① HTML 已经给 css/js 加了版本指纹 `?v=<hash>`；
 *   ② nginx 却一律回 `no-cache, must-revalidate`，还额外发 `Clear-Site-Data: "cache"`
 *      （让浏览器**清空**本站缓存）。
 * 结果是**每次导航都完整重传 CSS/JS**（实测 gzip 19.1 KB/次）。
 * 这类"两处配置各自都合理、合在一起互相抵消"的问题，只能靠对线上真实响应断言来守住。
 *
 * 断言：
 *   1. 带 `?v=` 的 css/js → 必须可长缓存（含 immutable）
 *   2. 不带 `?v=` 的 css/js → 必须每次校验（no-cache / must-revalidate），避免"改了看不到"
 *   3. 任何页面响应都**不得**再出现 `Clear-Site-Data`（它会清空缓存，与前两条冲突）
 *
 * 需要联网，属于 `check-all` 的在线检查部分。
 */
const BASE = process.env.QTVQ_BASE || 'https://qtvq.cn';
const problems = [];

async function head(url) {
  const res = await fetch(url, { method: 'GET', headers: { 'User-Agent': 'qtvq-check-cache/1.0' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  await res.arrayBuffer(); // 读完再释放，避免 keep-alive 干扰
  return {
    cacheControl: (res.headers.get('cache-control') || '').toLowerCase(),
    clearSiteData: res.headers.get('clear-site-data'),
  };
}

try {
  const html = await (await fetch(`${BASE}/`, { headers: { 'User-Agent': 'qtvq-check-cache/1.0' } })).text();
  const m = /(?:css\/styles\.css|js\/[a-z-]+\.js)\?v=([0-9a-f]{6,})/i.exec(html);
  const version = m ? m[1] : null;

  if (!version) {
    problems.push('首页 HTML 里没有找到 `?v=<hash>` 版本指纹 —— 少了指纹就不能安全长缓存');
  } else {
    const versioned = await head(`${BASE}/css/styles.css?v=${version}`);
    if (!versioned.cacheControl.includes('immutable')) {
      problems.push(
        `带指纹的 CSS 未使用长缓存（Cache-Control: "${versioned.cacheControl || '(无)'}"）—— 每次导航都要回源校验`,
      );
    }

    const plain = await head(`${BASE}/css/styles.css`);
    if (!/no-cache|must-revalidate/.test(plain.cacheControl)) {
      problems.push(
        `不带指纹的 CSS 未要求每次校验（Cache-Control: "${plain.cacheControl || '(无)'}"）—— 改了可能看不到`,
      );
    }
  }

  const page = await head(`${BASE}/`);
  if (page.clearSiteData) {
    problems.push(`首页响应仍带 Clear-Site-Data: ${page.clearSiteData} —— 它会清空浏览器缓存，抵消上面的长缓存`);
  }
} catch (err) {
  problems.push(`请求失败：${err.message}`);
}

if (problems.length === 0) {
  console.log('[check-cache-policy] ✅ 指纹资源长缓存 / 无指纹资源每次校验 / 未再清空缓存');
  process.exit(0);
}

console.error(`[check-cache-policy] ❌ ${problems.length} 处不符合：`);
for (const p of problems) console.error('  ' + p);
process.exit(1);
