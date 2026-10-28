#!/usr/bin/env node
/**
 * 问答链路安全接线检查（内容审核 + 危机转介）
 *
 * 为什么需要这个检查器
 * --------------------
 * 这一轮补的是「每问必走、但此前完全没有审核」的 `/v1/chat`，以及危机转介卡片。
 * 这两件事都有同一个失败模式：**改动看起来在，实际不生效**。
 *   · 把 `quickCheck` 挪到 `canAsk` 之后 → 违规内容照样扣用户配额；
 *   · 只在 Node 侧加、忘了 Pages 侧 → 流量一回退就裸奔（这个项目已经踩过一次：
 *     `sync-static` 与 `package-static` 的手写页面清单各漏一次）；
 *   · 有人觉得"号码写前端更方便"→ 前端复制一份，改一处漏一处，而这是电话号码；
 *   · 把危机判定简化成 `text.includes('死')` → 满屏「累死了」都弹求助卡片。
 * 这些都不会报错，只会安静地变差。所以逐条钉成断言。
 *
 * 判定原则：**能判红的才叫断言**。凡是本文件里的检查，都在 E.43 里做过一次
 * 变异测试（故意改坏 → 必须失败 → 还原），否则不作为交付依据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

let pass = 0;
const failures = [];
const warnings = [];

function read(rel) {
  const p = path.join(ROOT, rel);
  try {
    return fs.readFileSync(p, 'utf8');
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
  console.log(`  ❌ ${msg}${detail ? `\n       ${detail}` : ''}`);
}

function warn(msg) {
  warnings.push(msg);
  console.log(`  ⚠️  ${msg}`);
}

/** 去掉注释，避免把注释里的"反面示例"当真实代码（上一个检查器踩过这个坑） */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const CHAT_NODE = 'server/src/routes/chat.js';
const CHAT_PAGES = 'functions/api/chat.js';
const SAFETY_CORE = 'packages/safety/src/crisis.js';
const SAFETY_INDEX = 'packages/safety/src/index.js';

/* ── 1. 两条 chat 路径都必须接审核 ─────────────────────────────────────── */
console.log('\n[1] 问答链路内容审核');

for (const [label, rel, checkFn] of [
  ['Node /v1/chat', CHAT_NODE, 'quickCheck'],
  ['Pages /api/chat', CHAT_PAGES, 'localCheck'],
]) {
  const src = read(rel);
  if (!src) {
    bad(`${label}：文件不存在`, rel);
    continue;
  }
  const code = stripComments(src);
  if (code.includes(checkFn)) ok(`${label}：调用了 ${checkFn}`);
  else bad(`${label}：没有内容审核调用`, `找不到 ${checkFn}`);

  /* 字段名必须是 chat_question：它对应"全类别 review"策略。
     若误写成 profile/question，就会套用 block 策略，用户一叙述处境就被拒答。 */
  if (/chat_question/.test(code)) ok(`${label}：使用 chat_question 策略（不拦，只留痕）`);
  else bad(`${label}：字段名不是 chat_question`, '会套用 question 的 block 策略 → 受害者无法叙述处境');

  /*
   * 顺序：审核必须在配额检查**之前**。放在之后的话，违规内容照样扣用户的免费次数。
   *
   * 必须剔除 import 行再定位 —— 第一版直接用 indexOf，比的是
   * `import { quickCheck, ... }` 和 `import { canAsk, ... }` 的先后，
   * 而 import 永远在文件顶部，于是"把调用挪到配额之后"这种变异**完全测不出来**
   * （变异测试实跑发现：NOT-CAUGHT）。这是"看起来有断言、其实是摆设"的典型。
   */
  const codeOnly = code
    .split('\n')
    .filter((l) => !/^\s*import\b/.test(l))
    .join('\n');
  const safetyIdx = codeOnly.search(new RegExp(`${checkFn}\\s*\\(`));
  const quotaIdx = codeOnly.search(/canAsk\s*\(/);
  if (safetyIdx < 0 || quotaIdx < 0) {
    bad(`${label}：找不到审核或配额调用，顺序断言失效`);
  } else if (safetyIdx < quotaIdx) {
    ok(`${label}：审核在配额检查之前`);
  } else {
    bad(`${label}：审核在配额检查之后`, '违规内容会先扣掉用户的免费次数');
  }
}

/* ── 2. 两条路径都必须能下发 support ──────────────────────────────────── */
console.log('\n[2] 危机卡片下发');

for (const [label, rel] of [
  ['Node /v1/chat', CHAT_NODE],
  ['Pages /api/chat', CHAT_PAGES],
]) {
  const code = stripComments(read(rel) || '');
  if (/buildSupportCard/.test(code)) ok(`${label}：调用 buildSupportCard`);
  else bad(`${label}：没有生成 support 字段`);

  /* 生成失败分支也要带：卡片的存在不该取决于模型可用性 */
  const catchPart = code.slice(code.lastIndexOf('catch'));
  if (/support/.test(catchPart)) ok(`${label}：生成失败分支也带 support`);
  else bad(`${label}：生成失败时丢失 support`, '模型超时的时候，最需要求助资源的人反而拿不到');
}

/* ── 3. 号码只在共享层出现一次 ────────────────────────────────────────── */
console.log('\n[3] 求助号码单一来源');

const CORE = read(SAFETY_CORE);
if (!CORE) {
  bad('危机模块不存在', SAFETY_CORE);
} else {
  // 从源码里取号码，避免检查器自己也硬编码一份（那它就变成了第二个来源）
  const phones = [...CORE.matchAll(/phone:\s*'([0-9-]+)'/g)].map((m) => m[1]);
  if (phones.length >= 2) ok(`共享层声明了 ${phones.length} 个号码：${phones.join(' / ')}`);
  else bad('共享层号码数量异常', `解析到 ${phones.length} 个，应为 ≥2`);

  if (/国卫医政函/.test(CORE)) ok('12356 附了官方文号（可追溯）');
  else bad('号码缺少官方出处', '热线号码是会害人的字段，必须写清依据');

  /* 号码不得出现在前端或路由里 —— 只能来自共享层 */
  const scope = [
    'js/home.js',
    'js/report.js',
    'js/account.js',
    'apps/qtvq-uni/src/pages/index/index.vue',
    CHAT_NODE,
    CHAT_PAGES,
  ];
  /*
   * 只比对长度 ≥5 的号码。
   * 「120」是急救电话，但它同时也是 `120rpx`（小程序样式）与各种毫秒数常量 ——
   * 按字面量扫会一路误报（第一版就报了 3 处假阳性）。短号无法用字面量可靠区分，
   * 因此只对长号（12356 / 010-82951332）做泄漏检测；短号靠"三条号码都来自同一处"
   * 这个结构约束间接保护：前端拿不到 resources 就渲染不出任何号码。
   */
  const longPhones = phones.filter((x) => x.replace(/[^0-9]/g, '').length >= 5);
  let leaked = 0;
  for (const rel of scope) {
    const src = read(rel);
    if (!src) continue;
    for (const p of longPhones) {
      // 允许出现在注释里（说明来源），只拦代码中的字面量
      if (stripComments(src).includes(p)) {
        bad(`${rel}：硬编码了求助号码 ${p}`, '号码必须由服务端 buildSupportCard 下发');
        leaked += 1;
      }
    }
  }
  if (!leaked) ok(`前端与路由均未硬编码长号（${longPhones.join(' / ')} 全部由服务端下发）`);
}

/* ── 4. 危机判定必须具备抗误报结构 ───────────────────────────────────── */
console.log('\n[4] 危机判定抗误报');

if (CORE) {
  /*
   * 必须验证**调用**而不是**定义**：第一版只查 `NEGATION_RE` 这个标识符是否存在，
   * 于是"删掉 `if (isNegated(norm, m)) continue;`"（保留函数与常量定义）测不出来
   * —— 变异测试实跑为 NOT-CAUGHT。安全逻辑被"留着没用"是最隐蔽的失效方式。
   */
  const usesNegation = /isNegated\s*\(\s*norm\s*,\s*m\s*\)/.test(CORE);
  if (usesNegation) ok('否定语境处理在判定循环里被真正调用');
  else bad('否定语境处理没有被调用', '「我不想死」会被判成危机（常量还在，但没生效）');

  if (/NEGATION_RE\.test\(/.test(CORE)) ok('否定短语表被实际使用（NEGATION_RE.test）');
  else bad('否定短语表未被使用', '定义了却没用到，等于没做');

  if (/selfHasNeg/.test(CORE)) ok('命中片段自带否定词时不做二次排除（「不想活」才有效）');
  else bad('缺少 selfHasNeg 保护', '「不想活」会被自身的「不」判成否定，规则直接失效');

  if (/想\(要\|去\)\?死\(\?!你/.test(CORE.replace(/\s/g, ''))) ok('「想死你了」按后接人称代词排除');
  else bad('缺少「想死你了」排除', '思念会被判成危机');

  if (/要\(去死\|死\(\?!了\)\)/.test(CORE.replace(/\s/g, ''))) ok('「要死了」按口语排除，但保留「要去死」');
  else bad('缺少「要死了」排除', '「加班要死了」会弹求助卡片');
}

/* ── 5. 前端两处都要渲染 ─────────────────────────────────────────────── */
console.log('\n[5] 前端渲染');

const H5 = read('js/home.js');
if (H5 && /appendSupportCard\(data\.support\)/.test(H5)) ok('官网首页：回答后渲染求助卡片');
else bad('官网首页：没有渲染 support');

if (H5 && /tel:\$\{String\(r\.phone\)/.test(H5.replace(/\s/g, ' '))) ok('官网：号码渲染成可拨号链接');
else if (H5 && /tel:/.test(H5)) ok('官网：号码渲染成可拨号链接');
else bad('官网：号码不可点击');

const MP = read('apps/qtvq-uni/src/pages/index/index.vue');
if (MP && /support: data\.support/.test(MP)) ok('小程序首页：消息携带 support');
else bad('小程序首页：消息未携带 support');

if (MP && /makePhoneCall/.test(MP)) ok('小程序：可拨号');
else bad('小程序：无法拨号');

/* ── 6. 能力声明必须与实现一致 ───────────────────────────────────────── */
console.log('\n[6] 能力声明与实际一致');

const CAP_FIELDS = [
  ['server/src/lib/app-release.js', 'Node 侧'],
  ['functions/lib/app-release.js', 'Pages 侧'],
];

for (const [rel, label] of CAP_FIELDS) {
  const src = read(rel);
  if (!src) {
    bad(`${label}：能力清单不存在`, rel);
    continue;
  }
  for (const field of ['adultGate', 'crisisReferral']) {
    const m = src.match(new RegExp(`${field}:\\s*(true|false)`));
    if (!m) {
      bad(`${label}：缺少 ${field} 字段`);
      continue;
    }
    if (m[1] === 'true') ok(`${label}：${field} = true`);
    else bad(`${label}：${field} 仍为 false`, '实现已存在却声明 false，客户端会把入口藏起来');
  }
}

/* 声明 true 必须有对应实现，否则就是反过来"谎报有能力" */
if (read('apps/qtvq-uni/src/components/AdultGate.vue')) ok('adultGate=true 有实物：小程序 AdultGate.vue');
else bad('adultGate 声明 true 但没有组件实现');

if (CORE && /CRISIS_RESOURCES/.test(CORE) && read(SAFETY_INDEX)?.includes('buildSupportCard')) {
  ok('crisisReferral=true 有实物：共享层危机模块 + buildSupportCard');
} else {
  bad('crisisReferral 声明 true 但共享层不完整');
}

/* 双端能力字段必须一字不差：漂了就等于两个入口说着不同的话 */
const a = read('server/src/lib/app-release.js') || '';
const b = read('functions/lib/app-release.js') || '';
/*
 * 只取**布尔字面量**字段：login / notify / pay 是对象（由 Object.fromEntries 计算），
 * 它们的取值取决于环境，不该在这里比。
 * 行尾注释可有可无 —— 第一版要求必须有 `//`，结果 server 侧 `report: true,`
 * 没有注释就被漏掉，两边数量不等而误报"不一致"。
 */
const fieldsOf = (s) => [...s.matchAll(/^\s{4}([a-zA-Z]+):\s*(true|false)\b/gm)].map((m) => `${m[1]}=${m[2]}`);
const fa = fieldsOf(a);
const fb = fieldsOf(b);
if (fa.length && fb.length && fa.join() === fb.join()) {
  ok(`双端 ${fa.length} 个能力字段逐项一致`);
} else {
  const diff = fa.filter((x) => !fb.includes(x)).concat(fb.filter((x) => !fa.includes(x)));
  bad('双端能力字段不一致', diff.slice(0, 4).join(' / ') || '解析失败');
}

/* ── 汇总 ─────────────────────────────────────────────────────────────── */
console.log('');
if (warnings.length) {
  console.log(`⚠️  ${warnings.length} 项警告（不阻塞）`);
}
if (failures.length) {
  console.log(`❌ 问答链路安全接线：${failures.length} 项失败 / ${pass} 项通过`);
  process.exit(1);
}
console.log(`✅ 问答链路安全接线：${pass} 项全部通过`);
