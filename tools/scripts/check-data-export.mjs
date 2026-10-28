#!/usr/bin/env node
/**
 * 数据可携带（自助导出）与痛苦提示（第二档）接线检查
 *
 * 为什么这两件事放一个检查器
 * ------------------------
 * 它们是 E.45 里**唯一两项"清单上写着未完成、但其实代码能做"**的遗留：
 * `dataExport: false`（DSAR 只能人工受理）与「撑不下去了」拿不到任何回应。
 * 共同点是"做完之后很容易在后续改动里悄悄退化"：
 *
 *   · 导出接口多查一张表、多返回一个字段，就会在不报错的情况下把**别人的数据**
 *     或**登录凭据**带出去 —— 这种错不会在页面上体现，只会在某天变成事故。
 *   · 痛苦提示最容易被"优化"成每问都出现，一旦如此它就退化成壁纸，
 *     连带把危机卡片也变成"乱弹的东西"。
 *
 * 所以这里不只查"代码里有没有这个词"，更要**实际调用**纯函数看输出：
 * 断言的是"用户下载到的文件里到底有什么"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

let pass = 0;
const failures = [];

function read(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    return null;
  }
}

function ok(msg) {
  pass += 1;
  console.log(`  ✅ ${msg}`);
}

function bad(msg, detail = '') {
  failures.push(`${msg}${detail ? ` —— ${detail}` : ''}`);
  console.log(`  ❌ ${msg}${detail ? ` —— ${detail}` : ''}`);
}

function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
}

function mustMatch(label, src, pattern, rel) {
  if (src == null) {
    bad(label, `读不到 ${rel}`);
    return false;
  }
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  if (re.test(stripComments(src))) {
    ok(label);
    return true;
  }
  bad(label, `未匹配 ${re}（${rel}）`);
  return false;
}

function mustNotMatch(label, src, pattern, rel) {
  if (src == null) {
    bad(label, `读不到 ${rel}`);
    return false;
  }
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  if (re.test(stripComments(src))) {
    bad(label, `不该出现却出现了 ${re}（${rel}）`);
    return false;
  }
  ok(label);
  return true;
}

const importFile = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

/* ══ ① 导出接口本体 ═══════════════════════════════════════════════════════ */
console.log('\n=== ① 导出接口：只出本人数据，不出凭据 ===');

const routeSrc = read('server/src/routes/data-export.js');
mustMatch('导出路由存在', routeSrc, /router\.get\(\s*['"]\/export['"]/, 'server/src/routes/data-export.js');
mustMatch(
  '导出必须要求登录（requireAuth 挂在路由上）',
  routeSrc,
  /router\.get\(\s*['"]\/export['"],\s*requireAuth/,
  'server/src/routes/data-export.js',
);
mustMatch('导出有频次约束（冷却 + 429）', routeSrc, /COOLDOWN_MS[\s\S]{0,400}?429/, 'server/src/routes/data-export.js');
mustMatch('导出写审计日志（DSAR 要留痕）', routeSrc, /logAudit\(\{[\s\S]{0,200}?data_export/, 'server/src/routes/data-export.js');
mustMatch(
  '导出带 Content-Disposition（是下载而不是网页）',
  routeSrc,
  /Content-Disposition[\s\S]{0,120}?attachment/,
  'server/src/routes/data-export.js',
);
mustMatch(
  '导出声明 no-store（缓存里不该留一份个人数据）',
  routeSrc,
  /Cache-Control['"]\s*,\s*['"]no-store/,
  'server/src/routes/data-export.js',
);

mustMatch('路由已挂载到 /v1/me', read('server/src/app.js'), /app\.use\(\s*['"]\/v1\/me['"]\s*,\s*dataExportRoutes/, 'server/src/app.js');

/* 行为断言：直接调用 shaper，看"下载到的文件里到底有什么" */
try {
  const mod = await importFile('server/src/routes/data-export.js');
  const {
    shapeAccount,
    shapeLogin,
    shapeOrder,
    shapeQuestion,
    maskId,
  } = mod;

  const shaped = shapeAccount({
    _id: 'u1',
    nickname: '小王',
    profileVector: Array.from({ length: 128 }, () => 0.1),
    introVector: [0.2, 0.3],
    openid: 'oABCdefghijklmnop',
    createdAt: new Date('2026-01-02T03:04:05Z'),
  });
  if (!('profileVector' in shaped) && !('introVector' in shaped)) ok('账号导出剔除向量（128 维浮点不该进文件）');
  else bad('账号导出仍带向量', 'profileVector/introVector 会撑大文件且对用户无意义');

  if (shaped.openidMasked && !shaped.openidMasked.includes('defghijk')) ok('openid 只给脱敏值');
  else bad('openid 未脱敏', `实际：${shaped.openidMasked}`);

  const login = shapeLogin({
    userId: 'u1',
    phone: '13800000000',
    passwordHash: 'deadbeef',
    passwordSalt: 'cafe',
    sessionToken: 'tk',
    openid: 'oABCdefghijklmnop',
  });
  const loginKeys = Object.keys(login || {});
  if (!loginKeys.some((k) => /password|salt|token|session/i.test(k))) ok('账号表导出剔除密码/会话凭据');
  else bad('账号表导出带出了凭据', loginKeys.join(','));

  const order = shapeOrder({
    orderId: 'rpt_1',
    sku: 'pair',
    amountFen: 2990,
    status: 'paid',
    channel: 'wechat',
    trace: { ip: '1.2.3.4', phone: '13800000000', userAgent: 'UA' },
    createdAt: new Date('2026-01-02T03:04:05Z'),
  });
  if (!('trace' in order) && !JSON.stringify(order).includes('1.2.3.4')) ok('订单导出不含 trace（设备/IP/手机号）');
  else bad('订单导出带出了 trace', '导出文件常被转发，设备与联系信息不该在里面');

  if (Object.keys(order).every((k) => ['orderId', 'sku', 'amountFen', 'status', 'channel', 'createdAt', 'paidAt', 'refundedAt'].includes(k))) {
    ok('订单是白名单字段（新增字段默认不导出）');
  } else {
    bad('订单字段超出白名单', Object.keys(order).join(','));
  }

  const q = shapeQuestion({ question: 'q', answer: 'a', createdAt: new Date(), extraSecret: 'x' });
  if (!('extraSecret' in q)) ok('问答导出是白名单字段');
  else bad('问答导出带出了未声明字段');

  if (maskId('abcdefgh1234').startsWith('abcd') && maskId('abcdefgh1234').includes('*')) ok('脱敏保留首尾、中间打码');
  else bad('脱敏实现异常', maskId('abcdefgh1234'));
} catch (err) {
  bad('导出 shaper 行为断言无法执行', err.message);
}

/* ══ ② 能力声明与两端入口 ═══════════════════════════════════════════════ */
console.log('\n=== ② 能力声明与两端入口 ===');

const nodeRelease = read('server/src/lib/app-release.js');
const pagesRelease = read('functions/lib/app-release.js');
mustMatch('Node 能力清单声明 dataExport: true', nodeRelease, /dataExport:\s*true/, 'server/src/lib/app-release.js');
mustMatch('Pages 能力清单声明 dataExport: true', pagesRelease, /dataExport:\s*true/, 'functions/lib/app-release.js');

const accountHtml = read('account.html');
const accountJs = read('js/account.js');
mustMatch('官网账户页有导出按钮', accountHtml, /id="btn-export-data"/, 'account.html');
mustMatch('官网导出按钮有事件处理', accountJs, /getElementById\(['"]btn-export-data['"]\)\?\.addEventListener/, 'js/account.js');
mustMatch(
  '官网导出走带鉴权头的 fetch（不是直接跳转）',
  accountJs,
  /apiFetch\(\s*['"]\/v1\/me\/export['"]\s*\)/,
  'js/account.js',
);
mustNotMatch(
  '官网没有把 token 拼进 URL（会进历史与日志）',
  accountJs,
  /\/v1\/me\/export\?token=/,
  'js/account.js',
);

const profileVue = read('apps/qtvq-uni/src/pages/profile/profile.vue');
const mpExport = read('apps/qtvq-uni/src/api/export.js');
mustMatch('小程序「我的」有导出入口', profileVue, /@tap="exportData"/, 'pages/profile/profile.vue');
mustMatch('小程序导出处理函数存在', profileVue, /async function exportData\s*\(\)/, 'pages/profile/profile.vue');
mustMatch('小程序导出前校验登录态', profileVue, /if\s*\(!isLoggedIn\(\)\)/, 'pages/profile/profile.vue');
mustMatch('小程序导出走 shareFileMessage（文件才真正落到用户手里）', mpExport, /shareFileMessage/, 'api/export.js');
mustMatch('小程序有剪贴板兜底（不假装成功）', mpExport, /setClipboardData/, 'api/export.js');

/* ══ ③ 痛苦提示：第二档 ═════════════════════════════════════════════════ */
console.log('\n=== ③ 痛苦提示（第二档）：出现得起，且不喧宾夺主 ===');

const distressSrc = read('packages/safety/src/distress.js');
mustMatch('第二档模块存在', distressSrc, /export function distressCheck/, 'packages/safety/src/distress.js');
mustMatch('第二档提示构造器存在', distressSrc, /export function buildGentleTip/, 'packages/safety/src/distress.js');
mustMatch('第二档复用危机资源（号码不复制）', distressSrc, /import\s*\{[^}]*CRISIS_RESOURCES[^}]*\}\s*from\s*['"]\.\/crisis\.js['"]/, 'packages/safety/src/distress.js');

/* 号码单一来源：第二档文件里不该出现任何号码字面量 */
if (!/12356|82951332|120/.test(stripComments(distressSrc || ''))) ok('第二档文件内无号码字面量（单一来源）');
else bad('第二档文件里硬编码了号码', '号码只在 crisis.js 出现，写错等于把人引到空号');

const chatSrc = read('server/src/routes/chat.js');
mustMatch(
  'Node：明确级命中时不下发第二档（不叠两张）',
  chatSrc,
  /supportCard\s*\?\s*null\s*:\s*buildGentleTip\(/,
  'server/src/routes/chat.js',
);
mustMatch('Node：响应里带 gentle 字段', chatSrc, /\.\.\.\(gentleTip \? \{ gentle: gentleTip \}/, 'server/src/routes/chat.js');

const pagesChat = read('functions/api/chat.js');
mustMatch(
  'Pages：同一条互斥规则（两侧不许漂）',
  pagesChat,
  /support\s*\?\s*null\s*:\s*buildGentleTip\(/,
  'functions/api/chat.js',
);

const homeJs = read('js/home.js');
mustMatch('H5：渲染窄提示', homeJs, /function appendGentleTip/, 'js/home.js');
mustMatch('H5：一次会话只出现一次（sessionStorage 门）', homeJs, /sessionStorage\.getItem\(GENTLE_SHOWN_KEY\)/, 'js/home.js');
mustMatch('H5：可以永久关闭（localStorage）', homeJs, /localStorage\.getItem\(GENTLE_OFF_KEY\)/, 'js/home.js');
mustMatch('H5：有明确级时不再显示第二档', homeJs, /if\s*\(!data\.support\)\s*appendGentleTip\(/, 'js/home.js');
mustMatch('H5：窄提示样式存在', read('css/styles.css'), /\.gentle-tip\s*\{/, 'css/styles.css');
mustMatch('H5：窄提示边框是细线（不是卡片的整框）', read('css/styles.css'), /\.gentle-tip\s*\{[^}]*border-left-width/, 'css/styles.css');

const indexVue = read('apps/qtvq-uni/src/pages/index/index.vue');
mustMatch('小程序：渲染窄提示', indexVue, /class="gentle-tip"/, 'pages/index/index.vue');
mustMatch('小程序：钉在触发它的那条消息上（不是每条都渲染）', indexVue, /i === gentleAt/, 'pages/index/index.vue');
mustMatch('小程序：可永久关闭', indexVue, /function dismissGentle/, 'pages/index/index.vue');
mustMatch('小程序：关闭状态落盘', indexVue, /setStorageSync\(['"]qtvq_gentle_tip_off['"]/, 'pages/index/index.vue');

/* 行为断言：语料跑一遍 */
try {
  const { distressCheck, buildGentleTip } = await importFile('packages/safety/src/distress.js');
  const { crisisCheck } = await importFile('packages/safety/src/crisis.js');

  const shouldHit = [
    '我真的撑不下去了',
    '快扛不住了，每天都很累',
    '感觉好绝望',
    '看不到希望了',
    '活着太累',
    '我觉得没人懂我',
    '我受不了了',
    '这段感情让我走投无路',
  ];
  const shouldMiss = [
    '我受不了他天天打游戏',
    '我没有绝望，只是有点累',
    '没那么撑不住，还能再试一次',
    '今天加班好累',
    '笑死我了',
    '我想死你了',
    '分手了很难过，怎么办',
    '他最近工作压力很大',
  ];

  const missed = shouldHit.filter((s) => distressCheck(s).level !== 'distress');
  if (!missed.length) ok(`第二档语料召回 ${shouldHit.length}/${shouldHit.length}`);
  else bad('第二档漏报', missed.join(' / '));

  const falsePos = shouldMiss.filter((s) => distressCheck(s).level === 'distress');
  if (!falsePos.length) ok(`第二档误报 0/${shouldMiss.length}`);
  else bad('第二档误报', falsePos.join(' / '));

  // 危机句必须仍归第一档，否则"明确级"会被第二档稀释成软提示
  const crisisCases = ['我不想活了', '我想死', '我准备去死', '我想自杀'];
  const notCrisis = crisisCases.filter((s) => crisisCheck(s).level !== 'urgent');
  if (!notCrisis.length) ok('危机句仍判为明确级（第二档没有削弱第一档）');
  else bad('危机句降级了', notCrisis.join(' / '));

  const tip = buildGentleTip(distressCheck('我撑不下去了'));
  if (tip && tip.primary?.phone && Array.isArray(tip.resources) && tip.resources.length >= 1) {
    ok('第二档提示带得出至少一个可拨号码');
  } else {
    bad('第二档提示没有号码', '一条没有出路的提示等于空话');
  }
  /*
   * 注意：不能用 `JSON.stringify(tip).includes('source')` ——
   * `resources` 这个键名本身就包含 "source"（re-sourc-es），
   * 那样写永远判红。断言要看的是**每个资源对象上有没有 source 字段**。
   */
  const leaked = [...(tip?.resources || []), tip?.primary].filter((r) => r && 'source' in r);
  if (tip && !leaked.length) ok('第二档响应不含 source（只给展示需要的字段）');
  else bad('第二档响应把 source 也发出去了', 'source 是给维护者核实的，不该进客户端');
} catch (err) {
  bad('第二档行为断言无法执行', err.message);
}

/* ══ 汇总 ═══════════════════════════════════════════════════════════════ */
console.log('');
if (failures.length) {
  console.log(`❌ 数据导出与痛苦提示：${failures.length} 项失败 / ${pass} 项通过`);
  process.exit(1);
}
console.log(`✅ 数据导出与痛苦提示：${pass} 项全部通过`);
