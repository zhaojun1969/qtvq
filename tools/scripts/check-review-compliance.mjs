#!/usr/bin/env node
/**
 * 小程序审核合规接线检查（E.44）
 *
 * 为什么需要这个检查器
 * --------------------
 * 这一轮补的是"提审会被驳回、但代码里看不出来"的四类问题。它们的共同点：
 * **写错了不会报错，只会让审核卡在某个具体条款上**，而且驳回理由通常只写一句
 * 「请修改后重新提交」，不告诉你改哪里。
 *
 *   ① iOS 微信小程序不支持虚拟商品支付 —— 会员、缘值、额度都算。
 *      最危险的写法不是"没判断 iOS"，而是"判断了但只把直接扣款换成静态收款码"：
 *      代码看起来"处理过了"，实际是同一条违规的另一种写法。
 *   ② 付费产品需要有可查看的用户协议与隐私政策。
 *   ③ 录音属隐私接口，用户拒绝过后微信不再自动弹窗 —— 一律 toast「无法访问麦克风」
 *      会把用户引到系统设置里找一个不存在的开关。
 *   ④ 生成式 AI 服务只能用已备案模型。默认链里挂着境外兜底，平时不触发，
 *      但配额耗尽那一刻就会被真正调用。
 *
 * 判定原则与其它检查器一致：**能判红的才叫断言**。本文件的每一条都在 E.44 里做过
 * 变异测试（改坏 → 必须失败 → 还原），否则不作为交付依据。
 *
 * 一件事必须说清楚：这个检查器**不能替代**平台侧资质。
 * 「深度合成-AI问答」类目、算法备案编号、安全评估报告、与模型厂商的合作协议
 * 都只能在微信公众平台后台提交，代码里无从判断。检查器覆盖的是代码能做到的那部分。
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

function warn(msg) {
  warnings.push(msg);
  console.log(`  ⚠️  ${msg}`);
}

/**
 * 剥掉注释再匹配。
 *
 * 不剥的后果在本项目真实发生过：检查器把注释里写的**反面示例**
 * （"不要写成 `if (ios) return`"）当成了实现，于是永远通过。
 * 这里先去掉 `//` 与块注释，再对代码本体做断言。
 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
}

/** 断言：src 里能匹配到 pattern */
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

/* ══ ① iOS 虚拟支付 ═══════════════════════════════════════════════════════ */
console.log('\n=== ① iOS 微信小程序：虚拟商品支付必须整块不出现 ===');

const platformJs = read('apps/qtvq-uni/src/utils/platform.js');
mustMatch('platform.js 有 iOS 判定', platformJs, /export function isIosMiniProgram\s*\(/, 'utils/platform.js');
mustMatch('platform.js 有"整块禁用"判定', platformJs, /export function isVirtualPayBlocked\s*\(/, 'utils/platform.js');
mustMatch(
  'JSAPI 支持度已排除 iOS（不是只看 MP-WEIXIN）',
  platformJs,
  /export function supportsWechatJsapiPay\s*\(\)\s*\{[\s\S]*?!\s*isIosMiniProgram\s*\(/,
  'utils/platform.js',
);
mustMatch(
  'iOS 禁用文案是单一来源常量',
  platformJs,
  /export const VIRTUAL_PAY_BLOCKED_TIP/,
  'utils/platform.js',
);

const subscribeVue = read('apps/qtvq-uni/src/pages/subscribe/subscribe.vue');
/*
 * 断言写法说明：这里必须钉到**具体那一张卡**，不能只查 `v-if="!payBlocked"` 出现过。
 * 第一版就是那么写的，变异测试立刻暴露问题 —— 把「在线支付卡」的 v-if 去掉后
 * 静态收款码卡、提交表单上还有同样的指令，检查器照样全绿。
 * 也就是说那条断言测的是"文件里某处有这个字符串"，不是"付费入口被关掉了"。
 */
mustMatch(
  '订阅页：在线支付卡本身随 payBlocked 隐藏',
  subscribeVue,
  /<view v-if="!payBlocked" class="card pay-online-card">/,
  'subscribe.vue',
);
mustMatch('订阅页：iOS 有替代说明卡', subscribeVue, /v-if="payBlocked"/, 'subscribe.vue');
mustMatch('订阅页：直接扣款入口有 payBlocked 早退', subscribeVue, /async function startWalletPay\s*\(\)\s*\{[\s\S]{0,400}?if\s*\(\s*payBlocked\s*\)/, 'subscribe.vue');
mustMatch('订阅页：扫码入口有 payBlocked 早退', subscribeVue, /async function startQrPay\s*\(\)\s*\{[\s\S]{0,400}?if\s*\(\s*payBlocked\s*\)/, 'subscribe.vue');

const walletVue = read('apps/qtvq-uni/src/pages/wallet/wallet.vue');
mustMatch(
  '钱包页：充值卡本身随 payBlocked 隐藏',
  walletVue,
  /<view v-if="!payBlocked" class="card recharge">/,
  'wallet.vue',
);
mustMatch('钱包页：iOS 有替代说明卡', walletVue, /v-if="payBlocked"/, 'wallet.vue');
mustMatch('钱包页：充值入口有 payBlocked 早退', walletVue, /async function startPay\s*\(\)\s*\{[\s\S]{0,400}?if\s*\(\s*payBlocked\s*\)/, 'wallet.vue');

/* ══ ② 用户协议 / 隐私政策 ════════════════════════════════════════════════ */
console.log('\n=== ② 用户协议与隐私政策：两端都要能打开 ===');

const termsHtml = read('terms.html');
if (!termsHtml) {
  bad('terms.html 不存在', '付费产品必须有可查看的用户协议');
} else {
  ok('terms.html 存在');
  const t = stripComments(termsHtml);
  const clauses = [
    ['不构成医疗/心理诊断的免责', /不构成[\s\S]{0,40}(心理诊断|医疗建议)/],
    ['虚拟商品退款边界', /退款[\s\S]{0,200}(虚拟商品|无理由)/],
    ['未成年人付费限制', /(18\s*周岁|未成年人)/],
    ['AI 生成内容说明', /AI\s*生成/],
    ['iOS 端购买限制说明', /iOS/],
  ];
  for (const [label, re] of clauses) {
    if (re.test(t)) ok(`terms.html 含${label}`);
    else bad(`terms.html 缺${label}`, String(re));
  }
}

mustMatch('小程序「我的」有用户协议入口', read('apps/qtvq-uni/src/pages/profile/profile.vue'), /openWeb\(\s*['"]terms['"]\s*\)/, 'profile.vue');
mustMatch('订阅页下单前可查看协议', subscribeVue, /《用户协议》/, 'subscribe.vue');
mustMatch('订阅页可查看隐私政策', subscribeVue, /《隐私政策》/, 'subscribe.vue');

// 官网页脚入口：审核侧看的是"在你站上找得到"，缺一两个页面不影响产品，
// 但多半页面没有就说明是漏做，所以按数量设下限而不是要求 100%。
const htmlFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
const withTerms = htmlFiles.filter((f) => {
  const s = read(f);
  return s && /<p class="footer-line">[\s\S]{0,600}?terms\.html/.test(s);
});
if (withTerms.length >= 12) ok(`官网页脚有协议入口（${withTerms.length}/${htmlFiles.length} 个页面）`);
else bad('官网页脚协议入口覆盖不足', `仅 ${withTerms.length}/${htmlFiles.length}`);

/* ══ ③ 隐私授权（录音） ═══════════════════════════════════════════════════ */
console.log('\n=== ③ 隐私接口授权：被拒时要给出可操作的出路 ===');

const privacyJs = read('apps/qtvq-uni/src/utils/privacy.js');
mustMatch('privacy.js 导出 ensurePrivacyAuthorize', privacyJs, /export function ensurePrivacyAuthorize\s*\(/, 'utils/privacy.js');
mustMatch('调用微信官方授权接口', privacyJs, /requirePrivacyAuthorize\s*\(/, 'utils/privacy.js');
mustMatch('低版本基础库不判死（接口不存在时视为可用）', privacyJs, /typeof\s+api\.requirePrivacyAuthorize\s*!==\s*['"]function['"][\s\S]{0,80}resolve\(true\)/, 'utils/privacy.js');

mustMatch(
  '录音前先确认隐私授权',
  read('apps/qtvq-uni/src/utils/voice.js'),
  /export function startRecording[\s\S]{0,600}?ensurePrivacyAuthorize\s*\(/,
  'utils/voice.js',
);
mustMatch(
  '页面区分"隐私被拒"与"麦克风不可用"',
  read('apps/qtvq-uni/src/pages/index/index.vue'),
  /PRIVACY_DENIED/,
  'index.vue',
);

/* ══ ④ 生成式 AI：只用已备案的境内模型 ════════════════════════════════════ */
console.log('\n=== ④ 生成式 AI：默认只允许境内已备案模型 ===');

const nodeEnv = read('server/src/config/env.js');
const pagesChain = read('functions/lib/llm-chain.js');

mustMatch('Node 侧有境内提供方白名单', nodeEnv, /DOMESTIC_LLM_PROVIDERS\s*=\s*new Set\(/, 'config/env.js');
mustMatch('Pages 侧有境内提供方白名单', pagesChain, /DOMESTIC_PROVIDERS\s*=\s*new Set\(/, 'lib/llm-chain.js');

const domesticOf = (src) => {
  const m = stripComments(src || '').match(/new Set\(\[([^\]]*)\]\)/);
  return m ? m[1].replace(/['"\s]/g, '').split(',').filter(Boolean) : [];
};
const dn = domesticOf(nodeEnv);
const dp = domesticOf(pagesChain);
if (dn.length && dn.join() === dp.join()) ok(`双端境内白名单一致（${dn.join('/')}）`);
else bad('双端境内白名单不一致', `Node=${dn.join('/') || '空'} Pages=${dp.join('/') || '空'}`);

const defaultOn = (src) => /AI_DOMESTIC_ONLY[\s\S]{0,120}?!==\s*['"]false['"]/.test(stripComments(src || ''));
if (defaultOn(nodeEnv)) ok('Node 侧默认开启（未配置即生效）');
else bad('Node 侧境内限定不是默认开启', 'AI_DOMESTIC_ONLY 默认关闭时，境外兜底会被真实调用');
if (defaultOn(pagesChain)) ok('Pages 侧默认开启（未配置即生效）');
else bad('Pages 侧境内限定不是默认开启', 'AI_DOMESTIC_ONLY 默认关闭时，境外兜底会被真实调用');

// 空链必须退回而不是返回空 —— 空链的表现是"每问都是兜底话术"，比报错更难发现
mustMatch('Node 侧空链时退回完整链并告警', nodeEnv, /!effective\.length[\s\S]{0,300}?effective\s*=\s*parsed/, 'config/env.js');
mustMatch('Pages 侧空链时退回完整链并告警', pagesChain, /!domestic\.length[\s\S]{0,300}?return parsed/, 'lib/llm-chain.js');

/* ══ ⑤ 审核基础设施（回归保护） ═══════════════════════════════════════════ */
console.log('\n=== ⑤ 审核基础设施 ===');

const manifest = read('apps/qtvq-uni/src/manifest.json');
let appid = '';
try {
  appid = JSON.parse(manifest || '{}')?.['mp-weixin']?.appid || '';
} catch {
  /* 解析失败下面会判红 */
}
if (/^wx[0-9a-f]{16}$/.test(appid)) ok(`微信 appid 已配置（${appid}）`);
else bad('微信 appid 缺失或格式不对', appid || '空');

const apiConfig = read('apps/qtvq-uni/src/api/config.js');
if (apiConfig && /API_BASE\s*=\s*['"]https:\/\/qtvq\.cn['"]/.test(apiConfig)) {
  ok('接口基址用备案域名 qtvq.cn');
} else {
  bad('接口基址不是备案域名', '未备案域名会导致真机全部请求失败');
}
if (apiConfig && !/export const API_BASE\s*=\s*['"][^'"]*pages\.dev/.test(stripComments(apiConfig))) {
  ok('接口基址未回落 pages.dev（未备案，微信会拦）');
} else {
  bad('接口基址指向 pages.dev', '未备案域名，真机必挂');
}

// AI 生成标识：办法 2025-09-01 起强制执行，属"显示层缺失即违规"
mustMatch('官网问答有 AI 生成标识', read('js/home.js'), /本回答由 AI 生成|AI\s*生成/, 'js/home.js');
mustMatch('小程序问答有 AI 生成标识', read('apps/qtvq-uni/src/pages/index/index.vue'), /本回答由 AI 生成/, 'pages/index/index.vue');
mustMatch('报告页有 AI 生成标识', read('report.html'), /AI\s*生成/, 'report.html');

// 客服与举报：审核会看"用户能否联系到运营、能否投诉"
const profileVue = read('apps/qtvq-uni/src/pages/profile/profile.vue');
if (profileVue && /openContact\s*\(/.test(stripComments(profileVue))) ok('小程序内有客服入口');
else bad('小程序内没有客服入口', '审核侧会核"能否联系运营"');
if (fs.existsSync(path.join(ROOT, 'apps/qtvq-uni/src/pages/abuse/abuse.vue'))) ok('小程序内有举报入口');
else bad('小程序内没有举报入口', 'UGC 类产品必须有举报通道');

/* ── 汇总 ─────────────────────────────────────────────────────────────── */
console.log('');
if (warnings.length) console.log(`⚠️  ${warnings.length} 项警告（不阻塞）`);
if (failures.length) {
  console.log(`❌ 小程序审核合规接线：${failures.length} 项失败 / ${pass} 项通过`);
  process.exit(1);
}
console.log(`✅ 小程序审核合规接线：${pass} 项全部通过`);
