/**
 * 各端专用端口契约（自建 Node 版本）—— `/api/app/bootstrap` 用。
 *
 * 迁移自 Cloudflare Pages 的 `functions/lib/app-release.js`（契约逐字对齐）。
 * 纯逻辑部分（版本比较、更新判定、渠道表）直接复用**字节一致**的
 * `server/src/lib/app-release-core.js`（与 `functions/lib/app-release-core.js` 同一份）。
 *
 * ── 能力清单为什么必须"两边各算 + 强制比对"，而不是运行时互问 ──────────────
 * `capabilities` 的每一项都取决于**本侧的环境事实**（微信支付凭据、开放平台凭据、
 * 语音、邮件、LLM、RAG）。若 Node 去问 Pages，就把刚拆掉的跨海跳又装回来；
 * 若部署时写死，就把"运行时事实"冻成"发布快照"（改配置不生效，比现在更糟）。
 * 所以走第三条路：**两边各自算，再用双端比对闸门保证一致**
 * （`tools/scripts/check-app-bootstrap.mjs`，切 nginx 前必须全绿）。
 *
 * ── 键名策略（关键，别改成"映射层"）───────────────────────────────────────
 * 镜像到服务器的这批键**刻意沿用 Pages 侧的名字**
 * （`WECHAT_APP_ID` / `WECHAT_MINI_APP_SECRET` / `WECHAT_OPEN_*` …），
 * 这样两侧的能力判定就是**同名同义**、代码可以逐行对照，不需要一层"翻译"——
 * 而翻译层正是最容易悄悄分叉的地方（Node 自己那套 `WECHAT_MINI_APPID`/`WECHAT_MINI_SECRET`
 * 继续服务于 Node 的业务代码，两者互不影响）。
 */
import {
  APP_CHANNELS,
  DEFAULT_RELEASE,
  decideUpdate,
  isValidChannel,
  normalizeRelease,
} from './app-release-core.js';
import { APP_RELEASES_GENERATED } from '../data/app-releases.generated.js';
import { isRagReady } from '../data/rag-status.generated.js';
import { isNlsConfigured } from './aliyun-nls.js';
import { llmChainStatus } from '../config/env.js';

export { APP_CHANNELS, APP_CHANNEL_LABELS, APP_CHANNEL_KIND, DEFAULT_RELEASE, decideUpdate, isValidChannel, normalizeRelease } from './app-release-core.js';

/**
 * 与 Pages 侧 `releaseFor(channel)` **完全同义**：
 * `normalizeRelease(channel, APP_RELEASES_GENERATED?.[channel])`
 *
 * ⚠️ 这里**不能**写 `?? DEFAULT_RELEASE`（我第一版就写错了，被闸门抓出来）：
 * 没有发布记录的渠道必须返回 **null**，上游才能算出 `hadRelease=false` 与 `reason:'no_release'`。
 * 补上默认值会让 `hadRelease` 恒为 true → `reason` 变成 `up_to_date`，
 * 且 `release.channel` 的位置（键序）也会与 Pages 不同 —— 端侧据此判断"有没有正式发布"就错了。
 */
export function releaseFor(channel) {
  return normalizeRelease(channel, APP_RELEASES_GENERATED?.[channel]);
}

const has = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * 微信支付：与 `functions/lib/wechat-pay.js` 的
 * `isWechatPayConfigured` → `getWechatPayConfig` 判定字段完全一致
 * （appId / mchId / apiV3Key / privateKey / mchSerial / notifyUrl 六项齐全；公钥不参与判定）。
 */
function isWechatPayConfigured(env) {
  return Boolean(
    has(env.WECHAT_APP_ID) &&
      has(env.WECHAT_MCH_ID) &&
      has(env.WECHAT_API_V3_KEY) &&
      has(env.WECHAT_MCH_PRIVATE_KEY) &&
      has(env.WECHAT_MCH_SERIAL) &&
      has(env.WECHAT_PAY_NOTIFY_URL),
  );
}

/** 微信小程序登录：与 `functions/lib/wechat-mp.js` 同义（`WECHAT_APP_ID` + `WECHAT_MINI_APP_SECRET`） */
function isWechatMpLoginConfigured(env) {
  return has(env.WECHAT_APP_ID) && has(env.WECHAT_MINI_APP_SECRET);
}

/** 微信开放平台登录：与 `functions/lib/wechat-open.js` 的 `getWechatOpenConfig` 同义 */
function isWechatOpenLoginConfigured(env) {
  return has(env.WECHAT_OPEN_APP_ID) && has(env.WECHAT_OPEN_APP_SECRET) && has(env.WECHAT_OPEN_REDIRECT_URI);
}

/**
 * 邮件：对应 `functions/lib/mail.js` 的 `mailConfig`（两种通道任一配齐即算可用）。
 * ⚠️ 这一项是**两侧最可能不一致**的地方（Node 的 SMTP 凭据历史上放在
 * `/etc/qtvq-alert.env` 而不是 `server/.env`）—— 部署时必须把同一组 `SMTP_*` 也放进 `server/.env`，
 * 否则两边算出的 `notify.wechat` 会不同，而闸门才能发现。这里刻意保持与 Pages 同口径。
 */
function isMailConfigured(env) {
  const resend = String(env.MAIL_PROVIDER || '').toLowerCase() === 'resend';
  if (resend) return has(env.RESEND_API_KEY) && has(env.MAIL_FROM) && has(env.MAIL_TO);
  return Boolean(
    has(env.SMTP_HOST) && has(env.SMTP_PORT) && has(env.SMTP_USER) && has(env.SMTP_PASS) && has(env.SMTP_FROM) && has(env.SMTP_TO),
  );
}

/** LLM：Node 侧的等价物是链解析结果（Pages 侧看 `env.AI` 绑定 + 链） */
function isLlmReady() {
  try {
    return llmChainStatus().some((x) => x.configured);
  } catch {
    return false;
  }
}

/**
 * 能力清单：每一项都对应**服务端真的能做到**。刻意不放"产品规划"里的开关。
 * 结构与 `functions/lib/app-release.js` 的 `buildCapabilities` 逐字段一一对应。
 */
export function buildCapabilities(env = process.env) {
  const payReady = isWechatPayConfigured(env);
  const miniLogin = isWechatMpLoginConfigured(env);
  const openLogin = isWechatOpenLoginConfigured(env);
  const speech = isNlsConfigured(env);
  const mailReady = isMailConfigured(env);
  const llmReady = isLlmReady();
  const ragReady = isRagReady();

  const pay = Object.fromEntries(APP_CHANNELS.map((c) => [c, c === 'wechat' ? payReady : false]));
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
    notify: { wechat: miniLogin && mailReady },
    pay,
    voiceInput: speech,
    tts: false,
    llm: llmReady,
    rag: ragReady,
    report: true,
    /*
     * 下面这些字段**必须与 `functions/lib/app-release.js` 的 `buildCapabilities` 一字不差**。
     * 我第一次移植时源码窗口被截断，只抄到 `report: true` 就以为结束 ——
     * 双端比对立刻抓出少了这 8 项（真实后果：切上去后所有端的
     * 转盘/钱包/举报/资料/注销 会一次性消失、日志却全绿）。
     * 这正是"读代码以为等价"的翻车点，也是那道闸门不能省的原因。
     */
    wheel: true, // 转盘配对（Node /v1/wheel，已上线并验证）
    wallet: true, // 缘值钱包与充值（Node /v1/wallet + 微信在线支付自动到账）
    moderation: true, // 举报与内容安全（词表 + 人工审核）
    profile: true, // 个人资料
    deactivateAccount: true, // 自助注销（已上线并验证）
    dataExport: false, // 未开放自助导出（DSAR：仍需人工受理）
    /*
     * 2026-10-28 修正：这两项此前一直是 false，但实现早已存在 / 本轮补齐。
     * 这个文件的价值全在"如实"二字 —— 客户端会据此决定要不要渲染入口，
     * 声明 false 而实际有功能，等于把做好的东西藏起来；反过来更危险。
     */
    crisisReferral: true, // 危机转介卡片（packages/safety/src/crisis.js + /v1/chat 的 support 字段）
    adultGate: true, // 18+ 年龄门（H5 js/adult-gate.js、小程序 components/AdultGate.vue）
  };
}
