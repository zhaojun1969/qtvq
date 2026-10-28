#!/usr/bin/env node
/**
 * 审核合规检查器的**变异测试**（验证断言真的能判红）
 *
 * 为什么需要它
 * ------------
 * 一个从不失败的检查器比没有检查器更危险：它给出的是"已通过"的错觉。
 * 本项目 E.42 就踩过一次 —— 危机的六个变异**首轮全部没变红**，
 * 因为检查器只比对了第一个 `renderReport` 就收工。
 *
 * 做法：逐条把实现改坏（不是改检查器），跑检查器，**必须失败**，然后还原。
 * 任何一条"改坏了仍然通过"，说明那条断言是假断言，必须重写。
 *
 * 用法：node tools/scripts/test-review-compliance-mutation.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CHECKER = 'tools/scripts/check-review-compliance.mjs';

/** 每条变异：文件 / 原始片段 / 改坏后的片段 / 说明 */
const MUTATIONS = [
  {
    name: 'iOS 判定失效（JSAPI 只要微信小程序就放行）',
    file: 'apps/qtvq-uni/src/utils/platform.js',
    from: 'return !isIosMiniProgram();',
    to: 'return true;',
  },
  {
    name: '订阅页付费区不再随 iOS 隐藏',
    file: 'apps/qtvq-uni/src/pages/subscribe/subscribe.vue',
    from: '<view v-if="!payBlocked" class="card pay-online-card">',
    to: '<view class="card pay-online-card">',
  },
  {
    name: '钱包页充值入口去掉防御性早退',
    file: 'apps/qtvq-uni/src/pages/wallet/wallet.vue',
    from: `  if (payBlocked) {
    uni.showModal({ title: payBlockScope + '暂不支持', content: payBlockedTip, showCancel: false });
    return;
  }`,
    to: '  // mutated',
  },
  {
    name: '用户协议删掉退款边界条款',
    file: 'terms.html',
    from: '会员与缘值属于<strong>即时交付的虚拟商品</strong>，一经开通或充值到账即已履行。除下列情形外，不支持无理由退款：',
    to: '会员与缘值开通后即生效。',
  },
  {
    name: '录音不再先确认隐私授权',
    file: 'apps/qtvq-uni/src/utils/voice.js',
    from: 'ensurePrivacyAuthorize().then((ok) => {',
    to: 'Promise.resolve(true).then((ok) => {',
  },
  {
    name: '页面把隐私拒绝当成立麦克风失败',
    file: 'apps/qtvq-uni/src/pages/index/index.vue',
    from: "if (e?.code === 'PRIVACY_DENIED') {",
    to: 'if (false) {',
  },
  {
    name: 'Node 侧把境外模型放进境内白名单',
    file: 'server/src/config/env.js',
    from: "const DOMESTIC_LLM_PROVIDERS = new Set(['tongyi']);",
    to: "const DOMESTIC_LLM_PROVIDERS = new Set(['tongyi', 'workers-ai']);",
  },
  {
    name: 'Pages 侧境内限定改成默认关闭',
    file: 'functions/lib/llm-chain.js',
    from: "const domesticOnly = String(env?.AI_DOMESTIC_ONLY ?? '').trim().toLowerCase() !== 'false';",
    to: "const domesticOnly = String(env?.AI_DOMESTIC_ONLY ?? '').trim().toLowerCase() === 'true';",
  },
  {
    name: '接口基址改回未备案的 pages.dev',
    file: 'apps/qtvq-uni/src/api/config.js',
    from: "export const API_BASE = 'https://qtvq.cn';",
    to: "export const API_BASE = 'https://qtvq-api.pages.dev';",
  },

  /* ── E.46：多端（快手）支付与登录屏蔽 ─────────────────────────────── */
  {
    name: '付费禁用退回"只挡 iOS"，其它小程序端放行（本轮原始 bug）',
    file: 'apps/qtvq-uni/src/utils/platform.js',
    from: '  return isOtherMiniProgram() || isIosMiniProgram();',
    to: '  return isIosMiniProgram();',
  },
  {
    name: '非微信判定改成逐个列平台（漏加平台即漏挡）',
    file: 'apps/qtvq-uni/src/utils/platform.js',
    from: '  return !isWechatMiniProgram();',
    to: "  return platformLabel() === '支付宝小程序';",
  },
  {
    name: '其它小程序端也发"去网页版购买"的出口',
    file: 'apps/qtvq-uni/src/utils/platform.js',
    from: `  // #ifndef MP-WEIXIN
  return false;
  // #endif
}

/**
 * 付费区被禁用时的统一文案。`,
    to: `  // #ifndef MP-WEIXIN
  return true;
  // #endif
}

/**
 * 付费区被禁用时的统一文案。`,
  },
  {
    name: '屏蔽文案改成微信口径（快手端显示"受微信平台规则限制"）',
    file: 'apps/qtvq-uni/src/utils/platform.js',
    from: `// #ifndef MP-WEIXIN
export const VIRTUAL_PAY_BLOCKED_TIP =
  '本小程序不提供在线购买与充值，站内不涉及任何支付。免费功能与已购权益不受影响。';
// #endif`,
    to: `// #ifndef MP-WEIXIN
export const VIRTUAL_PAY_BLOCKED_TIP =
  '受微信平台规则限制，iOS 端小程序内不支持购买会员或充值缘值。请访问 qtvq.cn 完成购买。';
// #endif`,
  },
  {
    name: '微信一键登录不再只给微信端（快手端也渲染）',
    file: 'apps/qtvq-uni/src/pages/account/account.vue',
    from: `      <!-- #ifdef MP-WEIXIN -->
      <button class="btn-wechat btn-block" @click="wechatLogin">微信一键登录（推荐）</button>`,
    to: `      <button class="btn-wechat btn-block" @click="wechatLogin">微信一键登录（推荐）</button>`,
  },
  {
    name: '「我的」充值入口不再按平台裁剪（快手端出现微信支付字样）',
    file: 'apps/qtvq-uni/src/pages/profile/profile.vue',
    from: `        <!-- #ifdef MP-WEIXIN || H5 || APP-PLUS -->
        <button v-if="canTopup" class="btn-secondary" @tap="goRecharge">缘值充值（微信在线支付，自动到账）</button>
        <!-- #endif -->`,
    to: `        <button v-if="canTopup" class="btn-secondary" @tap="goRecharge">缘值充值（微信在线支付，自动到账）</button>`,
  },
  {
    name: '额度不足提示不再看平台（快手端仍指路微信充值）',
    file: 'apps/qtvq-uni/src/utils/platform.js',
    from: `  if (isVirtualPayBlocked()) return '。会员每日有免费次数，可在「办理会员」页查看。';`,
    to: '',
  },
  {
    name: '快手 appid 被清空',
    file: 'apps/qtvq-uni/src/manifest.json',
    from: '"appid": "ks651051624357102489",',
    to: '"appid": "",',
  },

  /* ── E.46：引流（官网/网址/下载入口/客服邮箱）─────────────────────── */
  {
    name: '导航栏副标题不再按平台裁剪（快手端显示 qtvq.cn）',
    file: 'apps/qtvq-uni/src/components/BrandNavBar.vue',
    from: `        <!-- #ifdef MP-WEIXIN || H5 || APP-PLUS -->
        <text class="brand-sub">我心永恒 · qtvq.cn</text>
        <!-- #endif -->
        <!-- #ifndef MP-WEIXIN || H5 || APP-PLUS -->
        <text class="brand-sub">我心永恒</text>
        <!-- #endif -->`,
    to: `        <text class="brand-sub">我心永恒 · qtvq.cn</text>`,
  },
  {
    name: '「客户端下载」入口不再按平台裁剪（引导站外下载）',
    file: 'apps/qtvq-uni/src/pages/profile/profile.vue',
    from: `        <!-- #ifdef MP-WEIXIN || H5 || APP-PLUS -->
        <view class="menu-item" hover-class="menu-item-hover" @tap="openWeb('download')">
          <text>客户端下载</text>
          <text class="arrow">›</text>
        </view>
        <!-- #endif -->`,
    to: `        <view class="menu-item" hover-class="menu-item-hover" @tap="openWeb('download')">
          <text>客户端下载</text>
          <text class="arrow">›</text>
        </view>`,
  },
  {
    name: '「关于」卡片不再按平台裁剪（快手端显示域名与 API 地址）',
    file: 'apps/qtvq-uni/src/pages/profile/profile.vue',
    from: `        <!-- #ifdef MP-WEIXIN || H5 || APP-PLUS -->
        <text class="about">qtvq.cn · 京ICP备19045082号\\n版本 {{ appVersion }} · 会员 ¥29/79/299\\nAPI: qtvq.cn</text>
        <!-- #endif -->
        <!-- #ifndef MP-WEIXIN || H5 || APP-PLUS -->
        <text class="about">京ICP备19045082号\\n版本 {{ appVersion }} · 会员 ¥29/79/299</text>
        <!-- #endif -->`,
    to: `        <text class="about">qtvq.cn · 京ICP备19045082号\\n版本 {{ appVersion }} · 会员 ¥29/79/299\\nAPI: qtvq.cn</text>`,
  },
  {
    name: '客服入口改回邮箱（快手端出现站外联系方式）',
    file: 'apps/qtvq-uni/src/pages/profile/profile.vue',
    from: `          <text>联系客服</text>`,
    to: `          <text>联系客服 qtvq@qtvq.cn</text>`,
  },
  {
    name: '找回密码说明改回"不需要绑定微信"',
    file: 'apps/qtvq-uni/src/pages/account/account.vue',
    from: '① 短信验证码找回（推荐，不需要额外授权）：',
    to: '① 短信验证码找回（推荐，不需要绑定微信）：',
  },
];

function runChecker() {
  const r = spawnSync(process.execPath, [CHECKER], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

const baseline = runChecker();
if (baseline.code !== 0) {
  console.error('❌ 基线未通过，先修好再跑变异测试：');
  console.error(baseline.out.split('\n').filter((l) => l.includes('❌')).slice(0, 10).join('\n'));
  process.exit(1);
}
console.log('✅ 基线通过，开始逐条变异\n');

let survived = 0;
let drifted = 0;
for (const m of MUTATIONS) {
  const abs = path.join(ROOT, m.file);
  const original = fs.readFileSync(abs, 'utf8');
  /*
   * 用文件自己的换行符去匹配。
   *
   * 踩过一次：仓库里的 .vue/.js 是 CRLF，而脚本里的多行片段写的是 LF，
   * `includes()` 直接不成立 —— 变异被当成"片段不存在"跳过，
   * 而跳过计入了 survived，看起来像"假断言"。跳过与存活必须分开计数，
   * 否则会误报假断言，去改本来是对的检查器。
   */
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const from = m.from.replace(/\n/g, eol);
  const to = m.to.replace(/\n/g, eol);
  if (!original.includes(from)) {
    console.log(`⚠️  跳过（片段已不存在，检查器与实现已漂移）：${m.name}`);
    drifted += 1;
    continue;
  }
  fs.writeFileSync(abs, original.replace(from, to), 'utf8');
  let res;
  try {
    res = runChecker();
  } finally {
    fs.writeFileSync(abs, original, 'utf8');
  }
  if (res.code === 0) {
    survived += 1;
    console.log(`❌ 变异存活（假断言）：${m.name}`);
  } else {
    const first = res.out.split('\n').find((l) => l.includes('❌')) || '';
    console.log(`✅ 已判红：${m.name}${first ? `\n     ${first.trim()}` : ''}`);
  }
}

console.log('');
if (drifted) console.log(`⚠️  ${drifted} 条变异因片段漂移被跳过（需同步更新本脚本）`);
if (survived) {
  console.log(`❌ ${survived}/${MUTATIONS.length} 条变异未被发现，检查器存在假断言`);
  process.exit(1);
}
if (drifted) {
  console.log(`❌ 有变异未能执行，本次不计为有效验证`);
  process.exit(1);
}
console.log(`✅ ${MUTATIONS.length}/${MUTATIONS.length} 条变异全部判红，断言有效`);
