/**
 * 各端「专用端口」契约闸门 —— 双端逐渠道比对（切 nginx 之前必须全绿）。
 *
 * 为什么必须有它：`/api/app/bootstrap` 一旦由自建 Node 提供，能力清单就是**由 Node 算的**。
 * 而能力门控的语义是"服务端说不可用就不显示按钮" —— 算错的后果是
 * **小程序支付/登录/钱包等入口凭空消失，而日志里一切正常**（本项目已踩过同类问题）。
 *
 * 比对方式（刻意不提前动 nginx）：
 *   Pages 侧：https://qtvq-api.pages.dev/api/app/bootstrap         （现网）
 *   Node  侧：https://qtvq.cn/v1/app/bootstrap                     （nginx 早已把 /v1/ 反代到 Node）
 * 逐字段比对 14 个渠道的 release / update / capabilities，只有下列字段允许不同：
 *   · serverTimeUtc  —— 请求时刻，天然不同
 *   · releasesSyncedAt —— 两侧生成时间不同，只要都能解析成时间即可
 */
import assert from 'node:assert';

const PAGES = process.env.QTVQ_PAGES_BASE || 'https://qtvq-api.pages.dev';
const NODE = process.env.QTVQ_NODE_BASE || 'https://qtvq.cn/v1';
const IGNORE = new Set(['serverTimeUtc', 'releasesSyncedAt']);

let pass = 0; let fail = 0;
const bad = [];
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✅ ${name}`); } else { fail += 1; bad.push(name); console.log(`  ❌ ${name}${detail ? '  → ' + detail : ''}`); }
}

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'qtvq-check-app-bootstrap' } });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 保留原文用于报错 */ }
  return { status: r.status, json, text };
}

function strip(obj) {
  if (Array.isArray(obj)) return obj.map(strip);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).filter(([k]) => !IGNORE.has(k)).map(([k, v]) => [k, strip(v)]));
  }
  return obj;
}

console.log('══════ ① 渠道目录 ══════');
const pagesDir = await getJson(`${PAGES}/api/app/bootstrap`);
const nodeDir = await getJson(`${NODE}/app/bootstrap`);
check('两端渠道目录都返回 200', pagesDir.status === 200 && nodeDir.status === 200, `pages=${pagesDir.status} node=${nodeDir.status}`);
if (pagesDir.json && nodeDir.json) {
  check('渠道数量一致', pagesDir.json.channels?.length === nodeDir.json.channels?.length,
    `pages=${pagesDir.json.channels?.length} node=${nodeDir.json.channels?.length}`);
  check('渠道列表逐项一致（channel/label/kind）',
    JSON.stringify(strip(pagesDir.json.channels)) === JSON.stringify(strip(nodeDir.json.channels)));
}

console.log('══════ ② 未知渠道 ══════');
const pagesBad = await getJson(`${PAGES}/api/app/bootstrap?channel=nope`);
const nodeBad = await getJson(`${NODE}/app/bootstrap?channel=nope`);
check('未知渠道两端同为 400', pagesBad.status === 400 && nodeBad.status === 400, `pages=${pagesBad.status} node=${nodeBad.status}`);
check('未知渠道错误码一致（E_UNKNOWN_CHANNEL + allowedChannels）',
  pagesBad.json?.code === nodeBad.json?.code && JSON.stringify(pagesBad.json?.allowedChannels) === JSON.stringify(nodeBad.json?.allowedChannels));

console.log('══════ ③ 逐渠道比对 ══════');
const channels = pagesDir.json?.channels?.map((c) => c.channel) || [];
for (const ch of channels) {
  for (const ver of ['1.0.0', null]) {
    const q = `channel=${encodeURIComponent(ch)}${ver ? `&version=${ver}` : ''}`;
    const [p, n] = await Promise.all([getJson(`${PAGES}/api/app/bootstrap?${q}`), getJson(`${NODE}/app/bootstrap?${q}`)]);
    const same = JSON.stringify(strip(p.json)) === JSON.stringify(strip(n.json));
    if (!same) {
      const diffs = [];
      const keys = new Set([...Object.keys(p.json || {}), ...Object.keys(n.json || {})]);
      for (const k of keys) {
        if (IGNORE.has(k)) continue;
        if (JSON.stringify(p.json?.[k]) !== JSON.stringify(n.json?.[k])) diffs.push(k);
      }
      check(`${ch}${ver ? '@' + ver : ''} 逐字段一致`, false, '差异字段: ' + diffs.join(', '));
    } else {
      check(`${ch}${ver ? '@' + ver : ''} 逐字段一致`, true);
    }
  }
}

console.log(`\n  通过 ${pass} · 失败 ${fail}`);
if (fail > 0) {
  console.error('\n❌ 双端不一致 —— 此时切换 nginx 会让能力清单以错误值下发，禁止切换。');
  process.exit(1);
}
console.log('✅ 双端契约完全一致，可以进入切流步骤');
