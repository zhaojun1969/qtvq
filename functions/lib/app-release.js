/**
 * 全端「专用端口」：能力清单 + 版本/更新决策（Pages 侧实现）
 *
 * 契约与 FTVF 项目（`D:\ftvf夫道\packages\shared\src\app-release.ts`）**同一套语义与字段名**：
 *   `GET /api/app/bootstrap?channel=<渠道>&version=<版本>`
 * 一次返回：该端的能力清单 + 该端的版本记录 + 更新结论（该不该更新、要不要强制）。
 *
 * ## 为什么必须有这个端点
 * 本项目原来判断"这个功能能不能用"靠零散接口：支付看 `/api/health` 的 `wechatPayConfigured`、
 * 语音看 `/api/speech`、模型看 `/api/health` 的 `llmChain`… 每加一个端（本次从 4 端加到 8 端
 * 加桌面加 App）就要教它"去问哪几个接口"，端一多必然漂移。
 * **漏问的后果不是报错，而是界面上出现点了没反应的功能。**
 *
 * ## 分工
 *   · 纯函数契约（渠道、版本比较、更新决策）→ `app-release-core.js`（无 import，可单测、端侧可复用）
 *   · 发布记录（版本/最低版本/更新方式/下载地址）→ 仓库根 `app-releases.json` 是**唯一源**，
 *     由 `tools/scripts/write-app-releases.mjs` 生成 `data/app-releases.generated.js`
 *   · 能力清单 → 本文件按服务端**真实已配置**的状态计算，不承诺未完成的能力
 *
 * 三条纪律（照抄 FTVF，理由成立）：没配好的一律 false 让客户端静默隐藏；
 * 无发布记录用出厂基线兜底；**客户端版本号非法时绝不强制更新**。
 */

import { APP_RELEASES_GENERATED, GENERATED_AT } from '../data/app-releases.generated.js';
import { isWechatPayConfigured } from './wechat-pay.js';
import { isNlsConfigured } from './aliyun-nls.js';
import { isMailConfigured } from './mail.js';
import { isWechatMpLoginConfigured } from './wechat-mp.js';
import { isWechatOpenLoginConfigured } from './wechat-open.js';
import { isLlmReady } from './llm-chain.js';
import { isRagReady } from './rag.js';

import {
  APP_CHANNELS,
  normalizeRelease,
} from './app-release-core.js';

/*
 * 渠道定义与纯函数**再导出**，调用方只需 import 一个文件。
 * 注意：这些名字只经 `export ... from` 出去，**不要**再在下面写 `export { X }`——
 * 那会产生重复导出，esbuild 直接构建失败（2026-09-21 实际踩到：
 * "Multiple exports with the same name isValidChannel"）。
 */
export {
  APP_CHANNELS,
  APP_CHANNEL_KIND,
  APP_CHANNEL_LABELS,
  DEFAULT_RELEASE,
  compareVersions,
  decideUpdate,
  isValidChannel,
  isValidVersion,
} from './app-release-core.js';

/** 发布记录生成时间，便于排查"这份数据是什么时候同步进来的" */
export const RELEASES_SYNCED_AT = GENERATED_AT;

/** 取某端的发布记录；没有或不合法 → null（由出厂基线兜底） */
export function releaseFor(channel) {
  return normalizeRelease(channel, APP_RELEASES_GENERATED?.[channel]);
}

/**
 * 能力清单：每一项都对应**服务端真的能做到**。
 * 刻意不放"产品规划"里的开关 —— 那会变成另一种坑：开关 true 但点了失败。
 */
export function buildCapabilities(env) {
  const payReady = isWechatPayConfigured(env);
  const miniLogin = isWechatMpLoginConfigured(env);
  const openLogin = isWechatOpenLoginConfigured(env);
  const speech = isNlsConfigured(env);
  const mailReady = isMailConfigured(env);
  const llmReady = isLlmReady(env);
  const ragReady = isRagReady();

  // 支付：只有"能调起支付"的端才算 true。
  // 微信小程序走 JSAPI；其它小程序平台各自的支付尚未接入（统一回落人工核实通道）。
  const pay = Object.fromEntries(APP_CHANNELS.map((c) => [c, c === 'wechat' ? payReady : false]));

  // 一键登录：微信小程序（code→session）、微信开放平台移动应用（App 内）、网页扫码（H5）
  const login = Object.fromEntries(
    APP_CHANNELS.map((c) => {
      if (c === 'wechat') return [c, miniLogin];
      if (c === 'web') return [c, openLogin];
      if (c === 'android' || c === 'ios' || c === 'harmony') return [c, openLogin];
      return [c, false];
    }),
  );

  return {
    login,
    // 订阅消息按模板授权，微信端要凭据齐（小程序）且邮件通道可用（运营能收到）
    notify: { wechat: miniLogin && mailReady },
    pay,
    voiceInput: speech,
    tts: false, // 未接入服务端 TTS（浏览器/系统语音属客户端能力，不计入服务端清单）
    llm: llmReady,
    rag: ragReady,
    report: true, // 配对报告（Node /v1/report，已上线并验证）
    wheel: true, // 转盘配对（Node /v1/wheel，已上线并验证）
    wallet: true, // 缘值钱包与充值（Node /v1/wallet + 微信在线支付自动到账）
    moderation: true, // 举报与内容安全（词表 + 人工审核）
    profile: true, // 个人资料
    deactivateAccount: true, // 自助注销（已上线并验证）
    dataExport: false, // 未开放自助导出（DSAR：仍需人工受理）
    /* 2026-10-28 修正：这两项此前为 false，但实现早已存在 / 本轮补齐。必须与
     * `server/src/lib/app-release.js` 一字不差（check-app-bootstrap-gate 会判红）。 */
    crisisReferral: true, // 危机转介卡片（packages/safety/src/crisis.js + /api/chat 的 support 字段）
    adultGate: true, // 18+ 年龄门（H5 js/adult-gate.js、小程序 components/AdultGate.vue）
  };
}
