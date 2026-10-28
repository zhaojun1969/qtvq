/**
 * 内容安全
 *
 * 三层设计，本地词表**始终生效**，外部服务可选：
 *   1. 本地词表 + 正则（本文件）—— 零成本、无延迟、必过；覆盖涉黄/涉赌/涉毒/诈骗/引流/辱骂
 *   2. 微信安全接口 `msg_sec_check`（可选，需 WECHAT_MINI_APPID/SECRET）
 *   3. 阿里云内容安全（**未实现**，需要持牌服务与 AccessKey 签名；留作升级路径，不做假的占位实现）
 *
 * 两点刻意的取舍：
 * - **不内置涉政词表**。涉政内容审核必须交给持牌内容安全服务，手工词表既不完整又会误伤；
 *   假装覆盖了反而是更大的风险。已在 README 写明这是已知缺口。
 * - **规范化后比对**。绕过词表最常见的手法就是插零宽字符或空格（"加 微 信"、"加*微*信"），
 *   所以除了原文比对，还会把非字母数字汉字全部压掉再比一次。
 *
 * 现状说明：小程序的 `msgSecCheck` 是给**小程序内**提交内容用的，用网站内容去校验属于灰色用法。
 * 正式上线建议接阿里云内容安全，本文件的 provider 结构就是为它预留的。
 */
import { env } from '../config/env.js';
import { ApiError } from '../lib/http.js';
import { recordLedger } from './moderation-ledger.js';
/*
 * 本地词表比对（规范化 / 压扁 / 词表比对 / 正则比对 / 字段处置策略）已迁到
 * `packages/safety`（跨端唯一来源，见该包头部说明）。服务端只保留**平台相关**部分：
 * 外部持牌服务调用、微信接口、审核台账、配置与健康状态。
 *
 * `localCheck` 继续从这里再导出：路由与 `tools/scripts/check-content-safety.mjs` 的
 * 既有 import 路径不必改动（也是刻意保持的兼容面）。
 */
import { localCheck, wordlistMeta } from '../../../packages/safety/src/index.js';

export { localCheck };

/*
 * 启动即打印词表装载情况。
 * 运维必须能一眼确认"新词表真的生效了" —— 改完词表忘了重启，是最常见的"改了没生效"。
 * 旧实现是惰性加载（第一次调用才读盘），一旦第一次调用发生在请求里，这行日志就淹没在流量里。
 */
{
  const meta = wordlistMeta();
  console.log(
    `[safety] 词表已加载：${meta.wordCount} 个词 / ${meta.patternCount} 条正则（v${meta.version}，${meta.updatedAt}）`,
  );
}

// ---------------------------------------------------------------- 阿里云内容安全（持牌服务，负责本地词表覆盖不到的部分）
//
// 为什么必须接它：本地词表**刻意不含涉政类词**（见 packages/safety/src/words.js 的 note）——
// 手工维护的政治敏感词表既不可能完整，也容易误伤；这类判断应由持牌内容安全服务做。
// 业务方 2026-10-11 明确要求"阿里云 Green + 本地 OCR + 敏感词"的多重方案。

/** 把 Green 的判定升级成统一结构（与本地命中同构，便于上层一视同仁地拦） */
function fromGreen(result) {
  const hits = (result.labels || []).map((label, i) => ({
    kind: 'provider',
    word: `阿里云内容安全(${label})`,
    category: result.categories?.[i] || label,
    severity: 'block',
  }));
  return {
    clean: false,
    hits,
    categories: result.categories || [],
    action: 'block',
    provider: result.provider,
    riskLevel: result.riskLevel,
  };
}

/**
 * 外部权威检查（阿里云 Green）。
 *
 * ⚠️ 失败时的处理是**刻意的**，不是"忘了处理异常"：
 *   · 未配置 → 跳过（provider 标为 local），并在 health/诊断里如实体现"没有外部审核"；
 *   · 调用失败（限流/网络/服务未开通）→ 返回 `degraded: true`，
 *     **不把它当成 pass，也不直接 block 用户**；上层据 `degraded` 决定转人工复核。
 *   之所以不"失败即拦截"：阿里云抖动会让所有用户都存不了资料（可用性事故）；
 *   之所以不"失败即放行且不留痕"：那等于审核形同虚设。所以是"放行 + 标记待复核"。
 */
async function greenCheck(text) {
  const { greenTextCheck, isGreenConfigured } = await import('./aliyun-green.js');
  if (!isGreenConfigured()) return { skipped: true, reason: 'not_configured' };
  try {
    const r = await greenTextCheck(text);
    return { skipped: false, result: r };
  } catch (err) {
    console.error('[safety] 阿里云内容安全调用失败（标记为待复核）：', err.message);
    return { skipped: false, error: err.message, degraded: true };
  }
}

// ---------------------------------------------------------------- 微信安全接口（可选）

let wxToken = { value: null, expiresAt: 0 };

async function wechatAccessToken() {
  if (wxToken.value && wxToken.expiresAt > Date.now() + 60_000) return wxToken.value;
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(
    env.wechatMiniAppId,
  )}&secret=${encodeURIComponent(env.wechatMiniSecret)}`;
  const res = await fetch(url);
  const json = await res.json();
  if (!json?.access_token) throw new Error(json?.errmsg || '获取 access_token 失败');
  wxToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in || 7200) * 1000 - 120_000 };
  return wxToken.value;
}

function isWechatConfigured() {
  return !!(env.wechatMiniAppId && env.wechatMiniSecret) && env.safetyProvider.includes('wechat');
}

async function wechatCheck(text) {
  const token = await wechatAccessToken();
  const url = `https://api.weixin.qq.com/wxa/msg_sec_check?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: String(text).slice(0, 2500), version: 1, scene: 2 }),
  });
  const json = await res.json();
  // 87014 = 内容含有违法违规内容
  if (json?.errcode === 87014) {
    return {
      clean: false,
      hits: [{ kind: 'provider', word: '微信安全接口', category: '违规内容', severity: 'block' }],
      categories: ['违规内容'],
      action: 'block',
      provider: 'wechat',
    };
  }
  if (json?.errcode && json.errcode !== 0) {
    throw new Error(`msg_sec_check 失败: ${json.errcode} ${json.errmsg}`);
  }
  return { clean: true, hits: [], categories: [], action: 'pass', provider: 'wechat' };
}

// ---------------------------------------------------------------- 对外统一入口

/**
 * 综合检查：**本地必过 + 外部权威服务（阿里云 Green）能查到问题就拦**。
 *
 * 顺序与理由：
 *   1. 本地词表先跑：零成本、最快，命中即拦（绝大多数违规在这里就被挡住，不必付费调外部）；
 *   2. 本地干净时再问 Green：覆盖本地词表**做不到**的（涉政/暴恐/违禁品/色情变体/广告违规）；
 *   3. Green **调用失败不阻塞业务**：返回 `degraded`，按本地结果放行并标记待复核 ——
 *      否则阿里云抖动会直接让用户存不了资料（可用性事故）。
 *      但**未配置**与**失败**必须区分：未配置 = 没有外部审核（如实报），失败 = 本次结论不完整。
 */
async function checkTextCore(text, { field = 'default' } = {}) {
  const local = localCheck(text, { field });
  if (local.action === 'block') return local;

  // ① 阿里云内容安全（持牌服务；未配置时 skipped）
  const green = await greenCheck(text);
  if (!green.skipped && green.result && !green.result.clean) {
    return fromGreen(green.result);
  }

  // ② 微信小程序内容安全（仅当配置了且 safetyProvider 含 wechat）
  if (isWechatConfigured()) {
    try {
      const remote = await wechatCheck(text);
      if (remote.action === 'block') return remote;
    } catch (err) {
      console.error('[safety] 微信内容检查失败（放行，按本地结果处理）:', err.message);
    }
  }

  // 把"外部审核是否真的生效"如实带回给调用方（供运营台/健康检查展示）
  return {
    ...local,
    external: {
      green: green.skipped ? 'skipped' : green.degraded ? 'degraded' : green.error ? 'error' : 'ok',
      ...(green.error ? { greenError: green.error } : {}),
    },
    // 外部服务异常时标记待复核：放行但留痕，运营可事后抽查
    ...(green.degraded ? { needsReview: true, degradedReason: green.error } : {}),
  };
}

/**
 * 对外入口：跑完整审核链路 + 写审核台账（P0-4）。
 *
 * 台账是**旁路**：`recordLedger` 内部吞掉所有异常，台账问题绝不会挡住正常审核；
 * 但它会 `await`，因为 Node 服务常驻，多一次 insert（1–3 ms）换取"每条审核都有记录"
 * 比"偶尔丢一条记录"划算得多 —— 台账的价值就在于完整性。
 *
 * 早期版本只 `console.log`，导致既无法回答申诉复议，也拿不出监管要求的审核记录。
 */
export async function checkText(text, { field = 'default', uid = null, clientId = null } = {}) {
  const result = await checkTextCore(text, { field });
  await recordLedger({
    field,
    uid,
    clientId,
    text,
    action: result.action,
    provider: result.provider || (Array.isArray(result.categories) && result.categories.length ? 'remote' : 'local'),
    categories: result.categories || [],
    hits: result.hits || [],
    degraded: !!(result.degraded || result.needsReview),
  });
  return result;
}

/** 直接抛错版本，便于路由里一行接入 */
export async function assertSafe(text, { field = 'default', label = '内容' } = {}) {
  const r = await checkText(text, { field });
  if (r.action === 'block') {
    const cats = r.categories.join('、');
    // 必须抛 ApiError：errorHandler 只认 ApiError 的 status，普通 Error 会被当成 500
    const err = new ApiError(400, `${label}包含不允许的内容（${cats}），请修改后重试`, 'E_CONTENT_BLOCKED');
    err.safety = { categories: r.categories, hits: r.hits };
    throw err;
  }
  return r;
}

/**
 * 内容安全现状（供 `/v1/safety/status` 与运营台展示）。
 *
 * 这里的每一个字段都是**运维必须能一眼看到的真相**：
 *   · 本地词表版本/词数 —— 确认新词表真的被加载了（改完词表没重启是最常见的"改了没生效"）；
 *   · 外部服务是否配置 —— "本地兜底"与"有持牌服务在审"是两件事，不能含糊。
 * 历史教训：这里曾写死 `aliyunGreenImplemented: false`，业务方看到后以为"还没做"，
 * 而实际是当时确实没做。现在改成如实反映实现与配置状态。
 */
export function safetyStatus() {
  const d = wordlistMeta();
  return {
    provider: env.safetyProvider,
    wordVersion: d.version,
    localWords: d.wordCount,
    localPatterns: d.patternCount,
    wechatConfigured: isWechatConfigured(),
    // 阿里云内容安全：代码已实现（services/aliyun-green.js），是否生效取决于 key + 服务开通
    aliyunGreenImplemented: true,
    aliyunGreenConfigured: !!(process.env.GREEN_ACCESS_KEY_ID || process.env.ALIYUN_SMS_ACCESS_KEY_ID)
      && !!(process.env.GREEN_ACCESS_KEY_SECRET || process.env.ALIYUN_SMS_ACCESS_KEY_SECRET),
  };
}
