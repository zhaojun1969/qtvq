#!/usr/bin/env node
/**
 * 两端埋点 SDK 的运行时验证（2026-10-28 · 计划书 E.40）
 *
 * 为什么不是"看代码就够"：埋点 SDK 有三件事**静态读不出来**——
 *   ① 发出去的报文形状是否和服务端 `POST /v1/track` 对得上（`{events, ch, anonId}`）；
 *   ② 登录态是否真的进了 `Authorization` 头（漏了就是 `uid=null`，激活恒 0）；
 *   ③ 批量阈值、失败回队是否真的按注释在跑（注释写"回队"，代码可能直接丢了）。
 *
 * 做法：用内存版宿主替换浏览器 / 小程序 API，再动态 import **真实 SDK 文件**。
 * 测的是同一份源码，不是复制出来的副本 —— 副本测试只能证明测试自己是对的。
 *
 * 覆盖两端：
 *   · 官网 `js/track.js`（localStorage + fetch + sendBeacon）
 *   · 小程序 `apps/qtvq-uni/src/utils/track.js`（uni.getStorageSync + uni.request）
 *
 * 用法：node tools/scripts/test-track-sdk.mjs
 */
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

let pass = 0;
const fails = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fails.push(name);
    console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}

const settle = () => new Promise((r) => setTimeout(r, 10));
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

// ══ 官网 SDK ═══════════════════════════════════════════════════════════════
console.log('\n【官网 js/track.js】');

const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
};
globalThis.location = { search: '?ch=xhs05' };
let beacons = 0;
// Node 22 的 `navigator` 是只读 getter，直接赋值会 TypeError，必须 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  value: { sendBeacon: () => { beacons += 1; return true; } },
  configurable: true,
  writable: true,
});
const fetchCalls = [];
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init });
  return { ok: true, status: 200 };
};

const h5 = await load('js/track.js');

h5.track('question_asked', { mode: 'ai' });
await settle();
h5.flush();
await settle();

const f1 = fetchCalls.at(-1);
check('打的是 /v1/track', f1?.url === '/v1/track', `实际 ${f1?.url}`);
check('未登录时不带 Authorization', !f1?.init?.headers?.Authorization);

// 登录态：写入与 auth.js 同名的键
ls.set('qtvq_auth_token', 'tok_h5_456');
h5.track('profile_complete', { completeness: 0.66 });
await settle();
h5.flush();
await settle();

const f2 = fetchCalls.at(-1);
check('登录后带 Authorization: Bearer', f2?.init?.headers?.Authorization === 'Bearer tok_h5_456', `实际 ${f2?.init?.headers?.Authorization}`);
check(
  '报文形状符合服务端契约',
  (() => {
    const body = JSON.parse(f2?.init?.body || '{}');
    const e = body.events?.[0];
    return e && typeof e.eventId === 'string' && e.event === 'profile_complete' && typeof e.ts === 'number' && body.ch === 'xhs05' && !!body.anonId;
  })(),
  f2?.init?.body?.slice(0, 160),
);

// 关键回归：已登录时**不能**走 sendBeacon（beacon 不能自定义请求头）
const beaconsBefore = beacons;
ls.delete('qtvq_auth_token');
h5.track('question_asked', { mode: 'beacon' });
await settle();
// 只有未登录才允许走 beacon；这里显式 flush(true) 模拟 pagehide
h5.flush(true);
await settle();
check('未登录时 pagehide 走 sendBeacon', beacons === beaconsBefore + 1, `实际新增 ${beacons - beaconsBefore}`);

/*
 * 本轮修的正是这一条：`sendBeacon` 不能自定义请求头，已登录用户走 beacon
 * 会把 Authorization 丢掉 → 服务端认不出人 → 激活恒 0。
 * 所以"登录态下即使是 pagehide 也必须走 fetch(keepalive)"必须被断言住。
 */
ls.set('qtvq_auth_token', 'tok_h5_789');
h5.track('question_asked', { mode: 'beacon-logged' });
await settle();
const beaconsBefore2 = beacons;
h5.flush(true);
await settle();
check('已登录时 pagehide 不走 sendBeacon', beacons === beaconsBefore2, `实际新增 ${beacons - beaconsBefore2}`);
check('已登录时 pagehide 仍带鉴权头', fetchCalls.at(-1)?.init?.headers?.Authorization === 'Bearer tok_h5_789', `实际 ${fetchCalls.at(-1)?.init?.headers?.Authorization}`);

// ══ 小程序 SDK ═════════════════════════════════════════════════════════════
console.log('\n【小程序 apps/qtvq-uni/src/utils/track.js】');

const store = new Map();
const requests = [];
let failNext = false;

globalThis.uni = {
  getStorageSync: (k) => (store.has(k) ? store.get(k) : ''),
  setStorageSync: (k, v) => store.set(k, v),
  removeStorageSync: (k) => store.delete(k),
  request: (opts) => {
    requests.push(opts);
    // 异步回调：同步回调会掩盖"先在 complete 里改状态"的竞态
    setTimeout(() => {
      if (failNext) {
        failNext = false;
        opts.fail?.({ errMsg: 'mock network error' });
      } else {
        opts.success?.({ statusCode: 200, data: { code: 0, data: { accepted: 1 } } });
      }
      opts.complete?.();
    }, 0);
  },
};

const mp = await load('apps/qtvq-uni/src/utils/track.js');

store.set('qtvq_channel', 'xhs05');
mp.track('question_asked', { mode: 'mp' });
await settle();
mp.flush();
await settle();

const r1 = requests.at(-1);
check('打的是 https://qtvq.cn/v1/track', r1?.url === 'https://qtvq.cn/v1/track', `实际 ${r1?.url}`);
check('未登录时不带 Authorization', !r1?.header?.Authorization);
check('渠道码来自 attribution（与官网同名键）', r1?.data?.ch === 'xhs05', `实际 ${r1?.data?.ch}`);
check('匿名 ID 已生成', typeof r1?.data?.anonId === 'string' && r1.data.anonId.length > 8);
check(
  '事件字段符合服务端契约（eventId/event/props/ts）',
  (() => {
    const e = r1?.data?.events?.[0];
    return e && typeof e.eventId === 'string' && e.event === 'question_asked' && typeof e.ts === 'number' && e.props?.mode === 'mp';
  })(),
  JSON.stringify(r1?.data?.events?.[0] || null),
);

store.set('qtvq_auth_token', 'tok_test_123');
mp.track('profile_complete', { completeness: 0.5 });
await settle();
mp.flush();
await settle();

const r2 = requests.at(-1);
check('登录后带 Authorization: Bearer', r2?.header?.Authorization === 'Bearer tok_test_123', `实际 ${r2?.header?.Authorization}`);
check('登录前后同一个端点', r2?.url === r1?.url);

const before = requests.length;
for (let i = 0; i < 10; i += 1) mp.track('report_landing_view', { i });
await settle();
check('满 10 条自动 flush 一次', requests.length === before + 1, `实际新增 ${requests.length - before} 次请求`);
const batch = requests.at(-1);
check('单次批量不超过服务端上限 20', (batch?.data?.events?.length || 0) <= 20, `实际 ${batch?.data?.events?.length}`);
check(
  '同一批 eventId 不重复（否则服务端唯一索引会静默丢事件）',
  (() => {
    const ids = (batch?.data?.events || []).map((e) => e.eventId);
    return ids.length === new Set(ids).size;
  })(),
);

failNext = true;
mp.track('question_asked', { mode: 'retry' });
await settle();
mp.flush();
await settle();
const queued = store.get('qtvq_track_queue') || [];
check('网络失败后事件回到队列', Array.isArray(queued) && queued.some((e) => e.props?.mode === 'retry'), `队列 ${JSON.stringify(queued).slice(0, 120)}`);

console.log('');
if (fails.length) {
  console.log(`❌ 埋点 SDK 验证未通过：${fails.length} 项失败 / ${pass} 项通过`);
  for (const f of fails) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✅ 埋点 SDK 验证通过：${pass} 项（官网 + 小程序）`);
