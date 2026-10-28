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

/* ── 多端：非微信小程序端不得出现"微信支付 / 微信登录 / 站外支付引导"（E.46）──
 *
 * 背景：快手 appid 落实后重新构建，产物里发现两处硬伤 ——
 *   ① `isVirtualPayBlocked()` 原来只认"微信 + iOS"，其它小程序端返回 false。
 *      于是快手端会照常渲染充值卡、按钮写着"微信支付 ¥xx"、点了拉起微信 Native 收款码。
 *      这不是"体验差"，是两条违规叠加：站内售卖虚拟商品未走平台支付 + 站内推广第三方支付。
 *   ② 额度不足提示写着"去用微信在线支付"，而快手端充值入口是隐藏的 —— 指路指到死胡同。
 *
 * 判定方式与前几轮不同：**这里配了一个极简条件编译求解器**。
 * 这类问题的本质是"`#ifdef` 写反了 / 漏了一个平台"，而源码里 `#ifdef` 两个分支是并存的：
 * 直接搜字符串既会漏（两个分支都含该词），也会误报（注释里提到也算）。
 * 求解器按目标平台裁掉非活动分支，断言的是**该平台最终会编译出什么**。
 */
function preprocessPlatform(src, tags) {
  const out = [];
  const stack = [];
  const active = () => stack.every((s) => s.active);
  const evalCond = (expr) =>
    expr
      .split('||')
      .map((s) => s.trim())
      .filter(Boolean)
      .some((part) => part.split('&&').map((s) => s.trim()).every((t) => tags.includes(t)));

  for (const line of String(src).split('\n')) {
    const m = line.match(/^\s*(?:\/\/|<!--|\/\*)\s*#(ifdef|ifndef|else|endif)\b(.*?)(?:-->|\*\/)?\s*$/);
    if (m) {
      const kind = m[1];
      const cond = (m[2] || '').replace(/-->\s*$|\*\/\s*$/, '').trim();
      if (kind === 'ifdef') stack.push({ active: evalCond(cond) });
      else if (kind === 'ifndef') stack.push({ active: !evalCond(cond) });
      else if (kind === 'else' && stack.length) stack[stack.length - 1].active = !stack[stack.length - 1].active;
      else if (kind === 'endif') stack.pop();
      continue;
    }
    if (active()) out.push(line);
  }
  return out.join('\n');
}

/** 取函数体（按花括号配对；只用于本项目这些没有"字符串里带花括号"的函数） */
function fnBody(src, name) {
  const at = src ? src.indexOf(`function ${name}(`) : -1;
  if (at < 0) return null;
  const start = src.indexOf('{', at);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start + 1, i);
    }
  }
  return null;
}

/** 只取 .vue 的模板段：script 与 style 里也有 `微信`/`qtvq.cn` 这类词，
 *  整文件匹配会把"改对了的模板"判红（改的是用户看得见的文案，不是代码里的标识符）。 */
function tplOf(src) {
  if (!src) return null;
  const a = src.indexOf('<template>');
  const b = src.lastIndexOf('</template>');
  return a >= 0 && b > a ? src.slice(a, b) : src;
}

const KUAI = ['MP', 'MP-KUAISHOU'];
const WX = ['MP', 'MP-WEIXIN'];
const platSrc = read('apps/qtvq-uni/src/utils/platform.js');
const kuaiPlat = platSrc ? stripComments(preprocessPlatform(platSrc, KUAI)) : null;
const wxPlat = platSrc ? stripComments(preprocessPlatform(platSrc, WX)) : null;

// 快手端：isVirtualPayBlocked 必须为真 —— 走的是"非微信小程序"分支，不是 iOS 分支
const kBlock = fnBody(kuaiPlat, 'isVirtualPayBlocked');
if (kBlock && kBlock.includes('isOtherMiniProgram')) ok('快手端：整块付费禁用判定命中"非微信小程序"分支');
else bad('快手端：付费禁用判定没走"非微信小程序"分支', '快手端会照常渲染充值卡与微信收款码');

// 快手端：isOtherMiniProgram 必须由"不是微信"推出，而不是逐个列平台（漏加平台就漏挡）
const kOther = fnBody(kuaiPlat, 'isOtherMiniProgram');
if (kOther && /!\s*isWechatMiniProgram\s*\(/.test(kOther)) ok('快手端：非微信判定由 !isWechatMiniProgram() 推出（新增平台不会漏挡）');
else bad('快手端：非微信判定不是"取反微信"，而是逐个列平台', '以后新加的平台会被当成微信端');

// 快手端：isWechatMiniProgram 不能再返回 true（否则上一条取反就成了 false）
const kIsWx = fnBody(kuaiPlat, 'isWechatMiniProgram');
if (kIsWx && !/return\s+true/.test(kIsWx)) ok('快手端：isWechatMiniProgram 已裁掉 return true 分支');
else bad('快手端：isWechatMiniProgram 仍返回 true', '条件编译没生效，整条判定链失效');

// 微信端：仍然是"只挡 iOS"，不能把安卓一起挡掉
const wBlock = fnBody(wxPlat, 'isVirtualPayBlocked');
if (wBlock && wBlock.includes('isIosMiniProgram')) ok('微信端：付费禁用仍只针对 iOS（安卓不受影响）');
else bad('微信端：付费禁用判定丢了 iOS 条件');

/** 取某个 const 声明的整段文本（到分号为止）——用于只检查"这一条文案"，不误伤同文件其它字符串 */
function constText(src, name) {
  const at = src ? src.indexOf(`const ${name}`) : -1;
  if (at < 0) return null;
  const semi = src.indexOf(';', at);
  return src.slice(at, semi < 0 ? src.length : semi).replace(/\s+/g, ' ');
}

// 文案：快手端不得出现微信平台规则、也不得给站外出口
const kTip = constText(kuaiPlat, 'VIRTUAL_PAY_BLOCKED_TIP');
if (kTip && !/微信/.test(kTip) && !/qtvq\.cn/.test(kTip) && /不提供在线购买/.test(kTip)) ok('快手端：屏蔽文案不提微信、不给站外地址');
else bad('快手端：屏蔽文案里出现了微信或站外地址', '这类平台的审核口径把"引导站外交易"本身算违规');
const wTip = constText(wxPlat, 'VIRTUAL_PAY_BLOCKED_TIP');
if (wTip && /iOS/.test(wTip) && /qtvq\.cn/.test(wTip)) ok('微信端：屏蔽文案仍说明 iOS 规则并给出浏览器出路');
else bad('微信端：屏蔽文案丢了 iOS 说明或出路');
const kCanRef = fnBody(kuaiPlat, 'canReferWebPurchase');
if (kCanRef && !/return\s+true/.test(kCanRef)) ok('快手端：不提供"复制网页版地址"出口');
else bad('快手端：仍提供站外购买出口');
const kScope = fnBody(kuaiPlat, 'payBlockScopeLabel');
if (kScope && /小程序内/.test(kScope)) ok('快手端：标题用"小程序内"而不是"iOS 端"');
else bad('快手端：标题文案沿用了"iOS 端"');
const wScope = fnBody(wxPlat, 'payBlockScopeLabel');
if (wScope && /iOS 端/.test(wScope)) ok('微信端：标题仍用"iOS 端"（同端另一端能买，说清哪端）');
else bad('微信端：标题文案丢了"iOS 端"');

// 模板：微信专属能力在快手包里必须整块消失（不是"渲染时隐藏"，是根本不在包里）
const accountRaw = read('apps/qtvq-uni/src/pages/account/account.vue');
const kuaiAccount = accountRaw ? stripComments(preprocessPlatform(tplOf(accountRaw), KUAI)) : null;
if (kuaiAccount && !/微信一键登录/.test(kuaiAccount) && !/@click="wechatLogin"/.test(kuaiAccount)) ok('快手端：无"微信一键登录"按钮');
else bad('快手端：仍渲染"微信一键登录"', '快手没有微信 provider，点了必定失败');
if (kuaiAccount && /手机号/.test(kuaiAccount)) ok('快手端：登录页给出手机号 + 密码的可用路径');
else bad('快手端：登录页没有可用的登录方式');
// 连"不需要绑定微信""之前用微信登录"这类事实性表述也一并中性化：
// 快手的巡检看的是整屏文案，逐句解释"这句不是引流"成本远高于改两个字
if (kuaiAccount && !/微信/.test(kuaiAccount)) ok('快手端：账号页不出现"微信"字样（含找回密码与改密说明）');
else bad('快手端：账号页仍有"微信"字样', '能力说明里带上第三方平台名，容易被判成能力不符');
const wxAccount = accountRaw ? stripComments(preprocessPlatform(tplOf(accountRaw), WX)) : null;
if (wxAccount && /微信一键登录/.test(wxAccount)) ok('微信端：一键登录按钮仍在');
else bad('微信端：一键登录按钮被误删');

const profileRaw = read('apps/qtvq-uni/src/pages/profile/profile.vue');
const kuaiProfile = profileRaw ? stripComments(preprocessPlatform(profileRaw, KUAI)) : null;
const wxProfile = profileRaw ? stripComments(preprocessPlatform(profileRaw, WX)) : null;
if (kuaiProfile && !/微信在线支付/.test(kuaiProfile)) ok('快手端：「我的」不再出现"缘值充值（微信在线支付）"');
else bad('快手端：「我的」仍有微信支付入口文案', '点进去只有一个"不支持"的页面，比没有入口更像坏了');
if (wxProfile && /微信在线支付/.test(wxProfile)) ok('微信端：充值入口仍在（未被多端改动误删）');
else bad('微信端：充值入口被误删');

// 额度不足提示：不能把用户指到一个在本端被隐藏的入口。
// 注意这条**不能**写成"函数里不出现微信"——两段文案都在同一个函数里（运行时分支），
// 那样写永远判红。要断言的是"被禁用那一支先返回中性文案"。
const kHint = fnBody(kuaiPlat, 'needQuotaHint');
if (kHint && /if\s*\(\s*isVirtualPayBlocked\(\)\s*\)\s*return\s*'。会员每日有免费次数/.test(kHint)) {
  ok('快手端：额度不足提示改为"会员每日免费次数"，不指向隐藏的充值页');
} else {
  bad('快手端：额度不足提示仍指向微信支付充值', '用户会被指到一个本端不存在的充值入口');
}
const reportVue = read('apps/qtvq-uni/src/pages/report/report.vue');
const wheelVue = read('apps/qtvq-uni/src/pages/wheel/wheel.vue');
if (reportVue && /needQuotaHint/.test(stripComments(reportVue)) && wheelVue && /needQuotaHint/.test(stripComments(wheelVue))) {
  ok('报告页与转盘页共用同一个额度提示来源');
} else {
  bad('报告页/转盘页仍在各自硬编码支付提示', '两处会各写一句，改一处漏一处');
}

// 快手 appid：填了才能上传；格式错会让构建产物带着错 appid，导入工具时才发现
const manifestRaw = read('apps/qtvq-uni/src/manifest.json');
const kAppid = manifestRaw ? (manifestRaw.match(/"mp-kuaishou"\s*:\s*\{[\s\S]*?"appid"\s*:\s*"([^"]*)"/) || [])[1] : null;
if (kAppid && /^ks\d{10,}$/.test(kAppid)) ok(`快手 appid 已填写（${kAppid.slice(0, 6)}…${kAppid.slice(-4)}）`);
else bad('快手 appid 缺失或格式不对', '格式应为 ks + 数字');

/* ── 引流：快手的审核规范把"官网/网址/二维码/电话/地址/第三方官方"都算违规 ──
 * 《版本信息审核规范》原文：不得含有第三方官方、官网、二维码、邀请码、网址、电话、
 * 地址、社交账号等相关联系方式的引流行为。小程序内顶着一个自家域名、一个客服邮箱、
 * 一个「客户端下载」入口，在微信里是正常信息，在快手是明确的驳回项。
 * 所以这几处按平台裁剪，而不是"审核时再说"。
 */
const navVue = read('apps/qtvq-uni/src/components/BrandNavBar.vue');
const kuaiNav = navVue ? stripComments(preprocessPlatform(tplOf(navVue), KUAI)) : null;
const wxNav = navVue ? stripComments(preprocessPlatform(tplOf(navVue), WX)) : null;
if (kuaiNav && !/qtvq\.cn/.test(kuaiNav)) ok('快手端：导航栏不显示官网域名');
else bad('快手端：导航栏仍显示 qtvq.cn', '这是"网址引流"，巡检最容易挑的一处');
if (kuaiNav && /我心永恒/.test(kuaiNav) && wxNav && /qtvq\.cn/.test(wxNav)) ok('两端导航栏副标题各自正确（品牌名 / 品牌名 · 域名）');
else bad('导航栏副标题被裁坏了（某一端丢了品牌名或域名）');

const kuaiProfileTpl = profileRaw ? stripComments(preprocessPlatform(tplOf(profileRaw), KUAI)) : null;
const wxProfileTpl = profileRaw ? stripComments(preprocessPlatform(tplOf(profileRaw), WX)) : null;
// 分开断言，不用一个复合条件：复合条件的失败信息分不清是域名漏了还是下载入口漏了，
// 调试时要靠猜（上一轮踩过"跳过 ≠ 存活"的同类问题）
if (kuaiProfileTpl && !/qtvq\.cn/.test(kuaiProfileTpl)) ok('快手端：「我的」不出现官网域名 / 客服邮箱');
else bad('快手端：「我的」仍出现官网域名或客服邮箱', '网址类引流在快手是明确驳回项');
if (kuaiProfileTpl && !/客户端下载/.test(kuaiProfileTpl)) ok('快手端：「我的」不出现"客户端下载"');
else bad('快手端：「我的」仍有"客户端下载"入口', '引导下载站外 App 属明确引流');
if (kuaiProfileTpl && /京ICP备/.test(kuaiProfileTpl)) ok('快手端：备案号仍保留（合规信息不随平台删）');
else bad('快手端：备案号被误删');
if (wxProfileTpl && /qtvq\.cn/.test(wxProfileTpl) && /客户端下载/.test(wxProfileTpl)) ok('微信端：官网地址与下载入口仍在（未被多端裁剪误删）');
else bad('微信端：官网地址或下载入口被误删');

// 客服邮箱：站内已有客服表单，邮箱是"绕开平台联系运营"，统一改成站内路径
const acctTpl = accountRaw ? stripComments(preprocessPlatform(tplOf(accountRaw), KUAI)) : null;
if (acctTpl && !/qtvq@qtvq\.cn/.test(acctTpl)) ok('快手端：账号页不出现客服邮箱（改用站内客服）');
else bad('快手端：账号页仍写客服邮箱');
if (profileRaw && !/qtvq@qtvq\.cn/.test(profileRaw)) ok('各端统一：客服入口不再以邮箱做入口（站内表单即可到达）');
else bad('仍有页面把邮箱当作客服入口', '平台内应优先站内客服通道');
// 客服页文案在共享 i18n 包里，没有条件编译可用 —— 只能整体不写邮箱
const zhCN = read('packages/i18n/src/zh-CN.js');
if (zhCN && !/qtvq@qtvq\.cn/.test(zhCN)) ok('客服页文案不含站外邮箱（i18n 无平台分支，只能统一去掉）');
else bad('客服页文案仍写客服邮箱', 'i18n 是共享包，没有 ifdef；快手包里会一并出现');

/* ── 汇总 ─────────────────────────────────────────────────────────────── */
console.log('');
if (warnings.length) console.log(`⚠️  ${warnings.length} 项警告（不阻塞）`);
if (failures.length) {
  console.log(`❌ 小程序审核合规接线：${failures.length} 项失败 / ${pass} 项通过`);
  process.exit(1);
}
console.log(`✅ 小程序审核合规接线：${pass} 项全部通过`);
