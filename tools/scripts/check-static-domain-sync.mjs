#!/usr/bin/env node
/**
 * 静态图片域名与源站的一致性校验（在线）
 *
 * 背景（2026-10-26）：
 *   为了卸载源站带宽，收款码图片改由 `https://static.qtvq.cn`（Cloudflare Pages）提供，
 *   而 HTML/CSS/JS 仍在源站。这意味着**图片有两份部署**：
 *     · 源站 /var/www/qtvq/assets/payment/*   ← 随 package-static.ps1 部署
 *     · Pages 项目 qtvq-site                   ← 需要单独 `wrangler pages deploy`
 *   一旦只更新了源站、忘了重新部署 Pages，用户拿到的就是**旧的收款码**。
 *   收款码错了 = 钱可能付给别人，这不是"图片不新鲜"，是资损。
 *
 * 断言：站点 HTML 里引用的每个静态图片，在源站与 static 域名上的
 *       **字节内容必须一致**（比对 SHA-256，而不是只看 200）。
 *
 * 需要联网，属于 check-all 的在线检查部分。
 */
import crypto from 'node:crypto';

const ORIGIN = 'https://qtvq.cn';
const STATIC = 'https://static.qtvq.cn';

const problems = [];

async function sha256(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'qtvq-check-static-sync/1.0' } });
  if (!res.ok) return { ok: false, status: res.status };
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: true, size: buf.length, hash: crypto.createHash('sha256').update(buf).digest('hex') };
}

try {
  const html = await (await fetch(`${ORIGIN}/`, { headers: { 'User-Agent': 'qtvq-check-static-sync/1.0' } })).text();

  // 从 HTML 里抠出指向 static 域名的图片路径（含 srcset 与 src）
  const paths = new Set();
  const esc = STATIC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(esc + '(/[^"\\s>]+)', 'g');
  for (const m of html.matchAll(re)) {
    paths.add(m[1]);
  }

  if (paths.size === 0) {
    console.log('[check-static-domain-sync] ℹ 页面未引用任何 static 域名图片（可能已回滚为纯源站），跳过');
    process.exit(0);
  }

  for (const p of paths) {
    const [a, b] = await Promise.all([sha256(`${ORIGIN}${p}`), sha256(`${STATIC}${p}`)]);
    if (!a.ok) {
      problems.push(`源站缺少该图：${p}（HTTP ${a.status}）—— 回滚时应保留源站副本`);
      continue;
    }
    if (!b.ok) {
      problems.push(`static 域名缺少该图：${p}（HTTP ${b.status}）—— 用户会看到裂图/旧图`);
      continue;
    }
    if (a.hash !== b.hash) {
      problems.push(
        `内容不一致：${p}（源站 ${a.size}B / static ${b.size}B）—— 很可能改了源站但忘了 ` +
          `wrangler pages deploy 到 qtvq-site；用户会拿到旧收款码`,
      );
    }
  }

  if (problems.length === 0) {
    console.log(`[check-static-domain-sync] ✅ ${paths.size} 张图片在源站与 static 域名上字节一致`);
    process.exit(0);
  }
  console.error(`[check-static-domain-sync] ❌ ${problems.length} 处不一致：`);
  for (const p of problems) console.error('  ' + p);
  console.error('\n修复：重新构建并部署纯静态包到 qtvq-site（见 docs 附录 E.26）。');
  process.exit(1);
} catch (err) {
  console.error(`[check-static-domain-sync] ❌ 请求失败：${err.message}`);
  process.exit(1);
}
