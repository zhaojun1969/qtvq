#!/usr/bin/env node
/**
 * 激活事件接线校验（2026-10-28 · 计划书 E.40）
 *
 * 为什么需要它：`metrics.js` 的 90 天验收门里有一条判据是「激活用户 ≥ 30」，
 * 而激活的定义是「`ACTIVATION_EVENTS` 里的事件，且事件带 uid」。
 * 这条链路有三处可以**静默**断掉，而且都不报错：
 *
 *   ① 客户端根本没有上报点 —— 事件只在白名单里，没有任何代码发它；
 *   ② 上报了但不带登录态 —— 服务端 `resolveIdentity` 拿到 null，落库 `uid=null`，
 *      聚合按 `uid != null` 过滤 → 一律不算激活；
 *   ③ 小程序端连 SDK 都没有 —— 小程序用户的激活永远统计不到。
 *
 * 三个都发生过（①②③ 在本文件诞生时同时成立），而看板只会冷静地显示 `activated: 0`，
 * 这与"还没有真实用户"在界面上完全无法区分。所以这条断言必须是**机器**的。
 *
 * 检查项：
 *   1. 每个激活事件在官网（`js/`）与小程序（`apps/qtvq-uni/src`）都有真实上报点；
 *   2. 两端所有 `track('x')` 的事件名都在服务端白名单里（拼错 = 静默丢弃）；
 *   3. 官网埋点带 `Authorization: Bearer`，且 token 键与 `auth.js` 的 `TOKEN_KEY` 一致；
 *   4. 官网 `sendBeacon` 分支只在未登录时走（beacon 不能自定义请求头）；
 *   5. 小程序埋点 SDK 存在、打 `/v1/track`、带登录态；
 *   6. 小程序付费入口（报告 / 转盘）**先过年龄门再发请求**（顺序断言，不只是"有调用"）。
 *
 * 用法：
 *   node tools/scripts/check-activation-wiring.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

let pass = 0;
const fails = [];
const warns = [];

function ok(name, detail = '') {
  pass += 1;
  console.log(`  ✅ ${name}${detail ? `（${detail}）` : ''}`);
}
function bad(name, detail = '') {
  fails.push(name);
  console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`);
}
function warn(name) {
  warns.push(name);
  console.log(`  ⚠️  ${name}`);
}

function read(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function walk(dirRel, exts, out = []) {
  const dir = path.join(ROOT, dirRel);
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(dirRel, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'unpackage', '.git'].includes(entry.name)) continue;
      walk(rel, exts, out);
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(rel);
    }
  }
  return out;
}

/** SDK 自身的注释里就写着 `track('…')` 示例，扫进去会变成假上报点 */
const SDK_FILES = new Set(['js/track.js', 'apps/qtvq-uni/src/utils/track.js']);

/** 提取 `track('x')` / `track("x")` 的事件名 → 出现位置 */
function collectEmitters(files) {
  const map = new Map();
  for (const rel of files) {
    if (SDK_FILES.has(rel.replace(/\\/g, '/'))) continue;
    const src = read(rel);
    const re = /\btrack\(\s*['"]([a-z0-9_]+)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      const name = m[1];
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(rel);
    }
  }
  return map;
}

// ── 1. 从服务端取"唯一事实来源" ─────────────────────────────────────────────

const trackSrc = read('server/src/routes/track.js');
const metricsSrc = read('server/src/services/metrics.js');

if (!trackSrc || !metricsSrc) {
  console.error('❌ 找不到服务端 track.js / metrics.js，无法校验');
  process.exit(2);
}

const whitelistBlock = trackSrc.match(/EVENT_WHITELIST\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
const whitelist = new Set((whitelistBlock?.[1] || '').match(/'([a-z0-9_]+)'/g)?.map((s) => s.slice(1, -1)) || []);

const activationBlock = metricsSrc.match(/ACTIVATION_EVENTS\s*=\s*\[([^\]]*)\]/);
const activation = (activationBlock?.[1] || '').match(/'([a-z0-9_]+)'/g)?.map((s) => s.slice(1, -1)) || [];

console.log(`\n白名单 ${whitelist.size} 个事件 · 激活事件 ${activation.length} 个（${activation.join(' / ')}）\n`);

if (!whitelist.size) bad('解析服务端事件白名单', 'EVENT_WHITELIST 未匹配到，检查器本身失效');
if (!activation.length) bad('解析激活事件', 'ACTIVATION_EVENTS 未匹配到，检查器本身失效');

// ── 2. 两端上报点 ───────────────────────────────────────────────────────────

const h5Emitters = collectEmitters(walk('js', ['.js']));
const uniEmitters = collectEmitters(walk('apps/qtvq-uni/src', ['.js', '.vue']));

for (const ev of activation) {
  const h5 = h5Emitters.get(ev) || [];
  const uni = uniEmitters.get(ev) || [];
  if (h5.length) ok(`官网上报「${ev}」`, h5.join(', '));
  else bad(`官网没有上报「${ev}」`, '该事件只在白名单/激活口径里，没有任何客户端代码发它 → 激活恒 0');

  if (uni.length) ok(`小程序上报「${ev}」`, uni.join(', '));
  else bad(`小程序没有上报「${ev}」`, '小程序用户永远不算激活');
}

// ── 3. 事件名必须在白名单内（拼错会被服务端静默丢弃）───────────────────────

function assertInWhitelist(label, map) {
  const unknown = [...map.keys()].filter((k) => !whitelist.has(k));
  if (!unknown.length) ok(`${label}事件名全部在白名单内`, `${map.size} 个`);
  else bad(`${label}有白名单外的事件名（会被静默丢弃）`, unknown.join(', '));
}
assertInWhitelist('官网', h5Emitters);
assertInWhitelist('小程序', uniEmitters);

const unused = [...whitelist].filter((e) => !h5Emitters.has(e) && !uniEmitters.has(e));
if (unused.length) warn(`白名单里这些事件两端都没人发：${unused.join(', ')}（不影响激活判据，但看板对应列为 0）`);

// ── 4. 官网埋点必须带登录态 ────────────────────────────────────────────────

const h5Track = read('js/track.js');
if (/Authorization\s*=\s*`Bearer/.test(h5Track)) ok('官网埋点带 Authorization: Bearer');
else bad('官网埋点没有带登录态', '事件会落成 uid=null，metrics 按 uid != null 过滤 → 激活/留存全为 0');

const h5Auth = read('js/auth.js');
const tokenKeyInAuth = h5Auth.match(/TOKEN_KEY\s*=\s*'([^']+)'/)?.[1] || '';
const tokenKeyInTrack = h5Track.match(/LS_TOKEN\s*=\s*'([^']+)'/)?.[1] || '';
if (tokenKeyInAuth && tokenKeyInAuth === tokenKeyInTrack) ok('官网埋点读取的 token 键与 auth.js 一致', tokenKeyInAuth);
else bad('官网埋点与 auth.js 的 token 键不一致', `auth.js=${tokenKeyInAuth || '(未找到)'} / track.js=${tokenKeyInTrack || '(未找到)'}`);

if (/sendBeacon[\s\S]{0,40}?/.test(h5Track) && /useBeacon\s*&&\s*!token/.test(h5Track)) {
  ok('官网 sendBeacon 只在未登录时使用', 'beacon 不能自定义请求头，登录态必须走 fetch');
} else {
  bad('官网 sendBeacon 分支没有排除登录态', '登录用户走 beacon 会丢 Authorization，等于回到 uid=null');
}

// ── 5. 小程序埋点 SDK ───────────────────────────────────────────────────────

const uniTrack = read('apps/qtvq-uni/src/utils/track.js');
if (!uniTrack) {
  bad('小程序缺埋点 SDK', 'apps/qtvq-uni/src/utils/track.js 不存在');
} else {
  if (uniTrack.includes('/v1/track')) ok('小程序埋点打 /v1/track');
  else bad('小程序埋点没有打 /v1/track');
  if (/Authorization\s*=\s*`Bearer/.test(uniTrack)) ok('小程序埋点带登录态');
  else bad('小程序埋点没有带登录态', '与官网同一个坑：uid=null → 不算激活');
  if (/uni\.request/.test(uniTrack)) ok('小程序埋点用 uni.request');
  else bad('小程序埋点没有用 uni.request（宿主 API 不匹配）');
}

const uniApp = read('apps/qtvq-uni/src/App.vue');
if (/onHide\(/.test(uniApp) && /flush/.test(uniApp)) ok('小程序切后台时 flush 埋点队列');
else warn('小程序 App.vue 没有在 onHide 时 flush（最后几个事件可能被定时器挂起丢掉）');

// ── 6. 付费入口必须先过年龄门 ──────────────────────────────────────────────

/**
 * 顺序断言：`ensureAdult(...)` 必须出现在"发请求"之前。
 * 只检查"有没有调用"是不够的 —— 放在请求之后等于用户先等 10–30 秒再被拦。
 */
function assertGateBefore(label, rel, gateRe, requestRe) {
  const src = read(rel);
  if (!src) return bad(`${label}：文件不存在`, rel);
  if (!/AdultGate/.test(src)) return bad(`${label}：没有挂 AdultGate 组件`, rel);

  const gateIdx = src.search(gateRe);
  const reqIdx = src.search(requestRe);
  if (gateIdx < 0) return bad(`${label}：没有调用 ensureAdult（年龄门形同虚设）`, rel);
  if (reqIdx < 0) return bad(`${label}：找不到发起请求的调用点，断言失效`, rel);
  if (gateIdx < reqIdx) ok(`${label}：先过年龄门再发请求`);
  else bad(`${label}：年龄门在请求之后`, `${rel} —— 用户要先等生成/扣费失败才会看到弹窗`);
}

assertGateBefore(
  '小程序报告页',
  'apps/qtvq-uni/src/pages/report/report.vue',
  /await\s+ensureAdult\(/,
  /await\s+generateReport\(/,
);
assertGateBefore(
  '小程序转盘页',
  'apps/qtvq-uni/src/pages/wheel/wheel.vue',
  /await\s+ensureAdult\(/,
  /await\s+spinWheel\(/,
);

/** ensureAdult 在页面没挂组件时必须严格失败（不能默认放行） */
const uniAdult = read('apps/qtvq-uni/src/utils/adult.js');
if (/if\s*\(!gate\?\.ensure\)\s*return\s+false/.test(uniAdult)) ok('小程序 ensureAdult 缺组件时严格失败');
else bad('小程序 ensureAdult 缺组件时没有严格失败', '等于忘记挂组件就放行未成年用户');

/**
 * `report_paid` 的边界：必须"生成成功之后 + 真的扣了钱"才报。
 *
 * 两个典型的退化写法都会让漏斗虚高，且不报错：
 *   a) 挪到点击时上报 —— 余额不足/配额拦下的请求也被记成付费；
 *   b) 去掉 `charged > 0` —— 免费档报告、幂等重放、券全额抵扣全算成付费。
 * 所以这里同时断言"顺序"和"门槛"。
 */
function assertReportPaidBoundary(label, rel, emitSrc, successSrc) {
  const src = read(rel);
  if (!src) return bad(`${label}：文件不存在`, rel);

  // 断言"调用点"而不是"函数定义"：把出口收成一个函数后，函数体天然在文件末尾，
  // 拿 track('report_paid') 的位置比大小会永远通过 —— 那就是假断言。
  //
  // 也不能只比"第一次出现"的先后：`js/report.js` 有两处生成成功（邀请接受 / 按 uid 生成），
  // 只比第一处的话，第二处被挪到前面照样通过（这个漏洞是实测出来的，第一版就漏了）。
  // 所以逐处检查：每一处上报，前面 150 字内必须能看到"生成成功"的那一行。
  const emits = [...src.matchAll(new RegExp(emitSrc, 'g'))].map((m) => m.index);
  if (!emits.length) return bad(`${label}：没有 report_paid 上报点`, rel);

  const successRe = new RegExp(successSrc);
  let good = 0;
  for (const idx of emits) {
    const before = src.slice(Math.max(0, idx - 150), idx);
    if (successRe.test(before)) good += 1;
    else
      bad(
        `${label}：有一处付费上报不在"生成成功"之后`,
        '点击就报 → 被余额/配额拦下的请求也算付费，漏斗比账实高',
      );
  }
  if (good === emits.length) ok(`${label}：${emits.length} 处付费上报都在生成成功之后`);

  if (/charged\s*>\s*0\s*&&\s*!billing\.replayed/.test(src)) {
    ok(`${label}：report_paid 有 charged>0 且非重放的门槛`);
  } else {
    bad(`${label}：report_paid 缺少扣费门槛`, '免费档/幂等重放/券全抵会被算成付费');
  }
}

assertReportPaidBoundary(
  '官网报告页',
  'js/report.js',
  String.raw`trackReportOutcome\(report\);`,
  String.raw`renderReport\(report, \{\s*isOwner`,
);
assertReportPaidBoundary(
  '小程序报告页',
  'apps/qtvq-uni/src/pages/report/report.vue',
  String.raw`trackReportOutcome\(report\.value\);`,
  String.raw`report\.value = data\.report \|\| data;`,
);

// ── 8. 营收口径：事件不得参与营收/付费计数 ────────────────────────────────

/**
 * 为什么这条必须是机器断言：`report_paid` 与 `membership_purchase` 在 2026-10-28
 * 之前一直没人上报，接的时候最自然的错误写法就是在 `metrics.js` 里
 * 「顺手也数一下事件」—— 于是同一笔钱在 `orders` 与事件侧各算一次。
 * 这个错误不会报错，只会让看板的营收比实际高一截，而且事后无法分辨哪些是重复的。
 */
const forbidden = ['report_paid', 'membership_purchase'];

/**
 * 去掉注释后再扫。口径说明里本来就写着「不许写 `e.event === 'report_paid'`」
 * 这句反面示例 —— 不剥注释的话，检查器会被自己的文档吓到（第一次跑就误报了一次）。
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const metricsCode = stripComments(metricsSrc);
const eventComparisons = [...metricsCode.matchAll(/\.event\s*===\s*['"]([a-z0-9_]+)['"]/g)].map((m) => m[1]);
const polluted = eventComparisons.filter((e) => forbidden.includes(e));
if (polluted.length) {
  bad(
    '营收口径被事件污染',
    `metrics.js 用 ${[...new Set(polluted)].join(' / ')} 做计数 —— 营收唯一真相必须是 orders 集合，` +
      '事件只做漏斗；两边都算会让同一笔钱重复计费',
  );
} else {
  ok('营收/付费计数只取 orders，事件不参与', `metrics.js 共 ${eventComparisons.length} 处事件判定，均为行为流`);
}

if (/collection\(ORDERS\)/.test(metricsSrc) && /reportPaidOrders/.test(metricsSrc)) {
  ok('报告实收由 orders 聚合（sku ∈ diagnose/retro/pair）');
} else {
  bad('找不到 orders 聚合', '营收口径失去了唯一真相，看板无法与账对账');
}

// ── 汇总 ───────────────────────────────────────────────────────────────────

console.log('');
if (warns.length) console.log(`  ⚠️  警告 ${warns.length} 条（不阻断）`);
if (fails.length) {
  console.log(`\n❌ 激活链路校验未通过：${fails.length} 项失败 / ${pass} 项通过`);
  for (const f of fails) console.log(`   · ${f}`);
  process.exit(1);
}
console.log(`✅ 激活链路校验通过：${pass} 项`);
